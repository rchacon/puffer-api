import type { DynamoDBBatchItemFailure, DynamoDBBatchResponse, DynamoDBRecord, DynamoDBStreamEvent } from 'aws-lambda';
import { ConditionalCheckFailedException, DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, PutCommand, QueryCommand, ScanCommand } from '@aws-sdk/lib-dynamodb';
import { childPk, progressSk, statusIndexPk, statusIndexSk } from '../../resolvers/lib/keys.js';
import { TABLE_NAME } from '../../lib/tableName.js';
import type { Activity, AttemptItem, ChallengeType, ProgressItem } from '../../resolvers/lib/types.js';
import { deriveProgress, type AttemptRecord } from './derive.js';

// DYNAMODB_ENDPOINT is only set for local dev/CI (DynamoDB Local); in a real deploy
// it's unset and the SDK resolves the real regional endpoint + Lambda role creds.
const isLocal = Boolean(process.env.DYNAMODB_ENDPOINT);
const client = DynamoDBDocumentClient.from(
  new DynamoDBClient({
    endpoint: process.env.DYNAMODB_ENDPOINT,
    ...(isLocal && {
      region: 'local',
      credentials: { accessKeyId: 'local', secretAccessKey: 'local' },
    }),
  })
);

// Manual invocation that recomputes progress summaries from attempts, for after
// the rules in ./derive.ts change (bump POLICY_VERSION there). With a childId it
// rebuilds that child; without one it rebuilds every child (a table Scan, fine
// at this scale). Example payload: {"rebuild":{"childId":"<id>"}}.
export interface RebuildEvent {
  rebuild: { childId?: string };
}

export interface RebuildResult {
  rebuilt: number;
}

// One target's worth of attempts; the unit progress is derived and stored for.
interface TargetKey {
  childId: string;
  activity: Activity;
  target: string;
}

interface StoredAttempt extends TargetKey, AttemptRecord {}

function groupKey({ childId, activity, target }: TargetKey): string {
  return JSON.stringify([childId, activity, target]);
}

// The attempt fields a stream record's NewImage must carry. A record missing
// any of them is malformed and is skipped, not retried: retrying can never
// fix it and would block the shard.
function attemptFromImage(image: NonNullable<NonNullable<DynamoDBRecord['dynamodb']>['NewImage']>): StoredAttempt | null {
  const id = image.id?.S;
  const childId = image.childId?.S;
  const activity = image.activity?.S;
  const target = image.target?.S;
  const challengeType = image.challengeType?.S;
  const correct = image.correct?.BOOL;
  const occurredAt = image.occurredAt?.S;
  if (!id || !childId || !activity || !target || !challengeType || correct === undefined || !occurredAt) {
    return null;
  }
  return {
    id,
    childId,
    activity: activity as Activity,
    target,
    challengeType: challengeType as ChallengeType,
    correct,
    occurredAt,
  };
}

function toRecord(item: Pick<AttemptItem, 'id' | 'challengeType' | 'correct' | 'occurredAt'>): AttemptRecord {
  return { id: item.id, challengeType: item.challengeType, correct: item.correct, occurredAt: item.occurredAt };
}

// Pages through `send`'s results via ExclusiveStartKey/LastEvaluatedKey until
// exhausted. Shared by queryHistory and scanAttempts, which otherwise differ
// only in which command they issue (and, for scanAttempts, whether it's a
// Query or a Scan).
async function* paginate(
  send: (startKey?: Record<string, unknown>) => Promise<{
    Items?: Record<string, unknown>[];
    LastEvaluatedKey?: Record<string, unknown>;
  }>
): AsyncGenerator<Record<string, unknown>> {
  let startKey: Record<string, unknown> | undefined;
  do {
    const page = await send(startKey);
    for (const item of page.Items ?? []) {
      yield item;
    }
    startKey = page.LastEvaluatedKey;
  } while (startKey);
}

// A target's full history, strongly consistent. Reads the base table rather
// than GSI1: GSI reads are only ever eventually consistent, which let two
// invocations processing different new attempts for the same target each
// miss the other's, even with no real concurrency involved -- whichever's
// write lost the watermark race (see writeProgress) was silently dropped
// for good. A consistent read here closes that gap, since by the time any
// invocation runs, every attempt whose stream event already fired has
// necessarily already committed.
async function queryHistory({ childId, activity, target }: TargetKey): Promise<AttemptRecord[]> {
  const attempts: AttemptRecord[] = [];
  const send = (startKey?: Record<string, unknown>) =>
    client.send(
      new QueryCommand({
        TableName: TABLE_NAME,
        KeyConditionExpression: 'PK = :pk AND begins_with(SK, :prefix)',
        FilterExpression: 'activity = :activity AND target = :target',
        ExpressionAttributeValues: {
          ':pk': childPk(childId),
          ':prefix': 'ATTEMPT#',
          ':activity': activity,
          ':target': target,
        },
        ConsistentRead: true,
        ExclusiveStartKey: startKey,
      })
    );
  for await (const item of paginate(send)) {
    attempts.push(toRecord(item as unknown as AttemptItem));
  }
  return attempts;
}

// Recomputes and stores one target's summary from its attempts. It overwrites
// every derived field, so replaying a stream record (or racing a rebuild) just
// rewrites the same values.
//
// The write is conditioned on `lastAttemptKey` so a writer computed from an
// older or smaller set of attempts can't clobber one already reflecting more
// (e.g. a manual rebuild racing a live stream batch for the same target: see
// "what protections" discussion). A tie is allowed through, not just a strict
// advance -- a rebuild re-deriving the *same* attempts under a bumped
// POLICY_VERSION must still be able to overwrite the summary it's correcting.
async function writeProgress(key: TargetKey, attempts: AttemptRecord[]): Promise<void> {
  const derived = deriveProgress(attempts);
  const item: ProgressItem = {
    PK: childPk(key.childId),
    SK: progressSk(key.activity, key.target),
    GSI1PK: statusIndexPk(key.childId, key.activity),
    GSI1SK: statusIndexSk(derived.status, key.target),
    childId: key.childId,
    activity: key.activity,
    target: key.target,
    ...derived,
  };
  try {
    await client.send(
      new PutCommand({
        TableName: TABLE_NAME,
        Item: item,
        ConditionExpression:
          'attribute_not_exists(PK) OR attribute_not_exists(lastAttemptKey) OR :lastAttemptKey >= lastAttemptKey',
        ExpressionAttributeValues: { ':lastAttemptKey': item.lastAttemptKey },
      })
    );
  } catch (err) {
    // Lost the race to a writer already holding newer data -- its write
    // stands, so there's nothing left for this one to do.
    if (!(err instanceof ConditionalCheckFailedException)) {
      throw err;
    }
  }
}

function mergeById(known: AttemptRecord[], stored: AttemptRecord[]): AttemptRecord[] {
  const byId = new Map<string, AttemptRecord>();
  for (const a of [...stored, ...known]) {
    byId.set(a.id, a);
  }
  return [...byId.values()];
}

interface ProjectGroup {
  key: TargetKey;
  attempts: StoredAttempt[];
  records: DynamoDBRecord[];
}

async function projectStream(event: DynamoDBStreamEvent): Promise<DynamoDBBatchResponse> {
  // Group the batch's new attempts by target: several records for one target
  // need one derivation, not one each.
  const groups = new Map<string, ProjectGroup>();
  for (const record of event.Records) {
    const image = record.dynamodb?.NewImage;
    // Only newly inserted attempts matter. This also skips the progress
    // summaries this Lambda writes itself, which would otherwise re-trigger it.
    if (record.eventName !== 'INSERT' || !image || !image.SK?.S?.startsWith('ATTEMPT#')) {
      continue;
    }
    const attempt = attemptFromImage(image);
    if (!attempt) {
      console.error('Skipping malformed attempt record', record.eventID);
      continue;
    }
    const gk = groupKey(attempt);
    const group = groups.get(gk) ?? { key: attempt, attempts: [], records: [] };
    group.attempts.push(attempt);
    group.records.push(record);
    groups.set(gk, group);
  }

  // Different targets are fully independent (different partition keys), so
  // they're projected concurrently rather than one at a time.
  const groupEntries = [...groups.values()];
  const results = await Promise.allSettled(
    groupEntries.map(async ({ key, attempts }) => {
      const stored = await queryHistory(key);
      await writeProgress(key, mergeById(attempts.map(toRecord), stored));
    })
  );

  const batchItemFailures: DynamoDBBatchItemFailure[] = [];
  results.forEach((result, i) => {
    if (result.status !== 'rejected') {
      return;
    }
    const { key, records } = groupEntries[i] as ProjectGroup;
    console.error('Failed to project progress', key, result.reason);
    // Report just this target's records so Lambda retries them (and everything
    // after) rather than the whole batch.
    for (const record of records) {
      const sequenceNumber = record.dynamodb?.SequenceNumber;
      if (sequenceNumber) {
        batchItemFailures.push({ itemIdentifier: sequenceNumber });
      }
    }
  });
  return { batchItemFailures };
}

// Every stored attempt for one child, or for all children, strongly consistent.
async function* scanAttempts(childId?: string): AsyncGenerator<StoredAttempt> {
  const send = (startKey?: Record<string, unknown>) =>
    childId
      ? client.send(
          new QueryCommand({
            TableName: TABLE_NAME,
            KeyConditionExpression: 'PK = :pk AND begins_with(SK, :prefix)',
            ExpressionAttributeValues: { ':pk': childPk(childId), ':prefix': 'ATTEMPT#' },
            ConsistentRead: true,
            ExclusiveStartKey: startKey,
          })
        )
      : client.send(
          new ScanCommand({
            TableName: TABLE_NAME,
            FilterExpression: 'begins_with(SK, :prefix)',
            ExpressionAttributeValues: { ':prefix': 'ATTEMPT#' },
            ConsistentRead: true,
            ExclusiveStartKey: startKey,
          })
        );
  for await (const image of paginate(send)) {
    const item = image as unknown as AttemptItem;
    yield { ...toRecord(item), childId: item.childId, activity: item.activity, target: item.target };
  }
}

async function rebuildProgress(childId?: string): Promise<RebuildResult> {
  const groups = new Map<string, { key: TargetKey; attempts: AttemptRecord[] }>();
  for await (const attempt of scanAttempts(childId)) {
    const gk = groupKey(attempt);
    const group = groups.get(gk) ?? { key: attempt, attempts: [] };
    group.attempts.push(toRecord(attempt));
    groups.set(gk, group);
  }
  // Different targets are fully independent (different partition keys), so
  // they're written concurrently rather than one at a time -- this matters
  // most here, where a full rebuild can span every child's every word.
  await Promise.all([...groups.values()].map(({ key, attempts }) => writeProgress(key, attempts)));
  return { rebuilt: groups.size };
}

export async function handler(event: DynamoDBStreamEvent | RebuildEvent): Promise<DynamoDBBatchResponse | RebuildResult> {
  if ('rebuild' in event) {
    return rebuildProgress(event.rebuild.childId);
  }
  return projectStream(event);
}
