import type { DynamoDBBatchItemFailure, DynamoDBBatchResponse, DynamoDBRecord, DynamoDBStreamEvent } from 'aws-lambda';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, PutCommand, QueryCommand, ScanCommand } from '@aws-sdk/lib-dynamodb';
import {
  attemptHistoryPk,
  childPk,
  progressSk,
  statusIndexPk,
  statusIndexSk,
} from '../../resolvers/lib/keys.js';
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

// A target's full history from GSI1. GSI reads are eventually consistent, so
// callers merge in the attempts they already know about.
async function queryHistory({ childId, activity, target }: TargetKey): Promise<AttemptRecord[]> {
  const attempts: AttemptRecord[] = [];
  let startKey: Record<string, unknown> | undefined;
  do {
    const page = await client.send(
      new QueryCommand({
        TableName: TABLE_NAME,
        IndexName: 'GSI1',
        KeyConditionExpression: 'GSI1PK = :pk',
        ExpressionAttributeValues: { ':pk': attemptHistoryPk(childId, activity, target) },
        ExclusiveStartKey: startKey,
      })
    );
    for (const item of (page.Items ?? []) as AttemptItem[]) {
      attempts.push(toRecord(item));
    }
    startKey = page.LastEvaluatedKey;
  } while (startKey);
  return attempts;
}

// Recomputes and stores one target's summary from its attempts. It overwrites
// every derived field, so replaying a stream record (or racing a rebuild) just
// rewrites the same values.
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
  await client.send(new PutCommand({ TableName: TABLE_NAME, Item: item }));
}

function mergeById(known: AttemptRecord[], stored: AttemptRecord[]): AttemptRecord[] {
  const byId = new Map<string, AttemptRecord>();
  for (const a of [...stored, ...known]) {
    byId.set(a.id, a);
  }
  return [...byId.values()];
}

async function projectStream(event: DynamoDBStreamEvent): Promise<DynamoDBBatchResponse> {
  // Group the batch's new attempts by target: several records for one target
  // need one derivation, and their attempts may not be in GSI1 yet.
  const groups = new Map<string, { key: TargetKey; attempts: StoredAttempt[]; records: DynamoDBRecord[] }>();
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

  const batchItemFailures: DynamoDBBatchItemFailure[] = [];
  for (const { key, attempts, records } of groups.values()) {
    try {
      const stored = await queryHistory(key);
      await writeProgress(key, mergeById(attempts.map(toRecord), stored));
    } catch (err) {
      console.error('Failed to project progress', key, err);
      // Report just this target's records so Lambda retries them (and everything
      // after) rather than the whole batch.
      for (const record of records) {
        const sequenceNumber = record.dynamodb?.SequenceNumber;
        if (sequenceNumber) {
          batchItemFailures.push({ itemIdentifier: sequenceNumber });
        }
      }
    }
  }
  return { batchItemFailures };
}

// Every stored attempt for one child, or for all children, strongly consistent.
async function* scanAttempts(childId?: string): AsyncGenerator<StoredAttempt> {
  let startKey: Record<string, unknown> | undefined;
  do {
    const page = childId
      ? await client.send(
          new QueryCommand({
            TableName: TABLE_NAME,
            KeyConditionExpression: 'PK = :pk AND begins_with(SK, :prefix)',
            ExpressionAttributeValues: { ':pk': childPk(childId), ':prefix': 'ATTEMPT#' },
            ConsistentRead: true,
            ExclusiveStartKey: startKey,
          })
        )
      : await client.send(
          new ScanCommand({
            TableName: TABLE_NAME,
            FilterExpression: 'begins_with(SK, :prefix)',
            ExpressionAttributeValues: { ':prefix': 'ATTEMPT#' },
            ConsistentRead: true,
            ExclusiveStartKey: startKey,
          })
        );
    for (const item of (page.Items ?? []) as AttemptItem[]) {
      yield { ...toRecord(item), childId: item.childId, activity: item.activity, target: item.target };
    }
    startKey = page.LastEvaluatedKey;
  } while (startKey);
}

async function rebuildProgress(childId?: string): Promise<RebuildResult> {
  const groups = new Map<string, { key: TargetKey; attempts: AttemptRecord[] }>();
  for await (const attempt of scanAttempts(childId)) {
    const gk = groupKey(attempt);
    const group = groups.get(gk) ?? { key: attempt, attempts: [] };
    group.attempts.push(toRecord(attempt));
    groups.set(gk, group);
  }
  for (const { key, attempts } of groups.values()) {
    await writeProgress(key, attempts);
  }
  return { rebuilt: groups.size };
}

export async function handler(event: DynamoDBStreamEvent | RebuildEvent): Promise<DynamoDBBatchResponse | RebuildResult> {
  if ('rebuild' in event) {
    return rebuildProgress(event.rebuild.childId);
  }
  return projectStream(event);
}
