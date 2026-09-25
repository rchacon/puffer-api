import { randomUUID } from 'node:crypto';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { GetItemCommand, PutItemCommand } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { createTable } from '../../scripts/create-table.js';
import { dynamoClient, marshall, TABLE_NAME, unmarshall } from '../../test/dynamoResolverHarness.js';
import { attemptHistoryPk, attemptHistorySk, attemptSk, childPk, progressSk } from '../../resolvers/lib/keys.ts';
import { POLICY_VERSION } from './derive.ts';
import { handler } from './index.ts';

const DAY = 24 * 60 * 60 * 1000;
const START = Date.UTC(2026, 0, 1, 12, 0, 0);

beforeAll(async () => {
  await createTable();
});

// A stored attempt item, shaped like what Mutation.recordAttempt writes.
function attemptItem(childId, target, day, challengeType, correct, activity = 'SIGHT_WORD') {
  const id = randomUUID();
  const occurredAt = new Date(START + day * DAY).toISOString();
  return {
    PK: childPk(childId),
    SK: attemptSk(id),
    GSI1PK: attemptHistoryPk(childId, activity, target),
    GSI1SK: attemptHistorySk(occurredAt, id),
    id,
    childId,
    activity,
    target,
    challengeType,
    answer: correct ? target : 'nope',
    correct,
    occurredAt,
    receivedAt: occurredAt,
  };
}

async function store(item) {
  await dynamoClient.send(new PutItemCommand({ TableName: TABLE_NAME, Item: marshall(item) }));
  return item;
}

// The stream record DynamoDB would emit when `item` is inserted.
let sequence = 0;
function insertRecord(item) {
  sequence += 1;
  return {
    eventID: `event-${sequence}`,
    eventName: 'INSERT',
    dynamodb: { SequenceNumber: String(sequence).padStart(10, '0'), NewImage: marshall(item) },
  };
}

async function getProgress(childId, target, activity = 'SIGHT_WORD') {
  const { Item } = await dynamoClient.send(
    new GetItemCommand({
      TableName: TABLE_NAME,
      Key: marshall({ PK: childPk(childId), SK: progressSk(activity, target) }),
    })
  );
  return Item ? unmarshall(Item) : null;
}

describe('progressProjector: stream events', () => {
  it('writes a summary from a newly inserted attempt, including one not yet visible in GSI1', async () => {
    const childId = randomUUID();
    // Deliberately not stored: GSI1 reads are eventually consistent, so the
    // batch's own attempts must count even if the index hasn't caught up.
    const item = attemptItem(childId, 'frog', 0, 'SPELL', true);

    const result = await handler({ Records: [insertRecord(item)] });

    expect(result).toEqual({ batchItemFailures: [] });
    expect(await getProgress(childId, 'frog')).toMatchObject({
      childId,
      activity: 'SIGHT_WORD',
      target: 'frog',
      status: 'IN_PROGRESS',
      attemptCount: 1,
      lastPracticedAt: item.occurredAt,
      lastAttemptKey: attemptHistorySk(item.occurredAt, item.id),
      policyVersion: POLICY_VERSION,
      GSI1PK: `CHILD#${childId}#ACTIVITY#SIGHT_WORD`,
      GSI1SK: 'STATUS#IN_PROGRESS#TARGET#frog',
    });
  });

  it("derives from the target's whole history, not just the batch", async () => {
    const childId = randomUUID();
    await store(attemptItem(childId, 'frog', 0, 'SPELL', true));
    await store(attemptItem(childId, 'frog', 3, 'SPELL', true));
    const latest = await store(attemptItem(childId, 'frog', 7, 'SPELL', true));

    await handler({ Records: [insertRecord(latest)] });

    expect(await getProgress(childId, 'frog')).toMatchObject({
      status: 'MASTERED',
      attemptCount: 3,
      GSI1SK: 'STATUS#MASTERED#TARGET#frog',
    });
  });

  it('counts an attempt once when it is both in the batch and in GSI1', async () => {
    const childId = randomUUID();
    const a = await store(attemptItem(childId, 'frog', 0, 'MULTIPLE_CHOICE', false));
    const b = await store(attemptItem(childId, 'frog', 1, 'MULTIPLE_CHOICE', false));

    await handler({ Records: [insertRecord(a), insertRecord(b)] });

    expect(await getProgress(childId, 'frog')).toMatchObject({ attemptCount: 2, status: 'NEEDS_SUPPORT' });
  });

  it('keeps children and targets separate', async () => {
    const childA = randomUUID();
    const childB = randomUUID();
    const frogA = attemptItem(childA, 'frog', 0, 'SPELL', true);
    const catA = attemptItem(childA, 'cat', 0, 'SPELL', false);
    const frogB = attemptItem(childB, 'frog', 0, 'SPELL', false);
    await Promise.all([frogA, catA, frogB].map(store));

    await handler({ Records: [insertRecord(frogA), insertRecord(catA), insertRecord(frogB)] });

    expect(await getProgress(childA, 'frog')).toMatchObject({ attemptCount: 1 });
    expect(await getProgress(childA, 'cat')).toMatchObject({ attemptCount: 1 });
    expect(await getProgress(childB, 'frog')).toMatchObject({ attemptCount: 1 });
    expect(await getProgress(childB, 'cat')).toBeNull();
  });

  it('is idempotent: replaying a record rewrites the same summary', async () => {
    const childId = randomUUID();
    const item = await store(attemptItem(childId, 'frog', 0, 'SPELL', true));
    const event = { Records: [insertRecord(item)] };

    await handler(event);
    const first = await getProgress(childId, 'frog');
    await handler(event);

    expect(await getProgress(childId, 'frog')).toEqual(first);
  });

  it('ignores records that are not newly inserted attempts', async () => {
    const childId = randomUUID();
    const item = await store(attemptItem(childId, 'frog', 0, 'SPELL', true));
    const summary = { PK: childPk(childId), SK: progressSk('SIGHT_WORD', 'frog') };

    const result = await handler({
      Records: [
        { ...insertRecord(item), eventName: 'MODIFY' },
        { ...insertRecord(item), eventName: 'REMOVE' },
        // The summaries this Lambda writes come back through the stream too.
        insertRecord({ ...summary, childId, status: 'IN_PROGRESS' }),
        { eventID: 'no-image', eventName: 'INSERT', dynamodb: { SequenceNumber: '1' } },
      ],
    });

    expect(result).toEqual({ batchItemFailures: [] });
    expect(await getProgress(childId, 'frog')).toBeNull();
  });

  it('skips a malformed attempt record instead of retrying it forever', async () => {
    const childId = randomUUID();
    const bad = insertRecord({ PK: childPk(childId), SK: attemptSk('abcdefgh'), id: 'abcdefgh' });
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});

    const result = await handler({ Records: [bad] });

    expect(result).toEqual({ batchItemFailures: [] });
    expect(errors).toHaveBeenCalled();
    errors.mockRestore();
  });

  it("reports a failed target's records so Lambda retries them, and still projects the others", async () => {
    const childId = randomUUID();
    const ok = await store(attemptItem(childId, 'cat', 0, 'SPELL', true));
    const failing = await store(attemptItem(childId, 'frog', 0, 'SPELL', true));
    const okRecord = insertRecord(ok);
    const failingRecord = insertRecord(failing);
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});

    // Fail the first data source call, which is the failing target's GSI1 query
    // (targets are projected in the order their records appear).
    const send = vi.spyOn(DynamoDBDocumentClient.prototype, 'send').mockRejectedValueOnce(new Error('boom'));
    const result = await handler({ Records: [failingRecord, okRecord] });
    send.mockRestore();
    errors.mockRestore();

    expect(result).toEqual({
      batchItemFailures: [{ itemIdentifier: failingRecord.dynamodb.SequenceNumber }],
    });
    expect(await getProgress(childId, 'frog')).toBeNull();
    expect(await getProgress(childId, 'cat')).toMatchObject({ attemptCount: 1 });
  });

  it("doesn't let a writer with older data clobber a summary already reflecting newer data", async () => {
    const childId = randomUUID();
    const stale = attemptItem(childId, 'frog', 0, 'SPELL', true);
    const newer = attemptItem(childId, 'frog', 5, 'SPELL', true);

    // Simulate a summary a concurrent writer already advanced past `stale`,
    // e.g. a live stream batch that raced ahead of a rebuild still working
    // from an older snapshot.
    await store({
      PK: childPk(childId),
      SK: progressSk('SIGHT_WORD', 'frog'),
      GSI1PK: `CHILD#${childId}#ACTIVITY#SIGHT_WORD`,
      GSI1SK: 'STATUS#IN_PROGRESS#TARGET#frog',
      childId,
      activity: 'SIGHT_WORD',
      target: 'frog',
      status: 'IN_PROGRESS',
      attemptCount: 2,
      lastPracticedAt: newer.occurredAt,
      lastAttemptKey: attemptHistorySk(newer.occurredAt, newer.id),
      policyVersion: POLICY_VERSION,
    });

    const result = await handler({ Records: [insertRecord(stale)] });

    expect(result).toEqual({ batchItemFailures: [] });
    expect(await getProgress(childId, 'frog')).toMatchObject({
      attemptCount: 2,
      lastAttemptKey: attemptHistorySk(newer.occurredAt, newer.id),
    });
  });
});

describe('progressProjector: rebuild', () => {
  it("rebuilds one child's summaries from their attempts", async () => {
    const childId = randomUUID();
    const other = randomUUID();
    await store(attemptItem(childId, 'frog', 0, 'SPELL', true));
    await store(attemptItem(childId, 'frog', 3, 'SPELL', true));
    await store(attemptItem(childId, 'frog', 7, 'SPELL', true));
    await store(attemptItem(childId, 'cat', 0, 'SPELL', false));
    await store(attemptItem(other, 'frog', 0, 'SPELL', true));

    const result = await handler({ rebuild: { childId } });

    expect(result).toEqual({ rebuilt: 2 });
    expect(await getProgress(childId, 'frog')).toMatchObject({ status: 'MASTERED', attemptCount: 3 });
    expect(await getProgress(childId, 'cat')).toMatchObject({ status: 'IN_PROGRESS', attemptCount: 1 });
    // Only the requested child was touched.
    expect(await getProgress(other, 'frog')).toBeNull();
  });

  it('replaces summaries computed under an older policy', async () => {
    const childId = randomUUID();
    await store(attemptItem(childId, 'frog', 0, 'SPELL', false));
    await store({
      PK: childPk(childId),
      SK: progressSk('SIGHT_WORD', 'frog'),
      GSI1PK: `CHILD#${childId}#ACTIVITY#SIGHT_WORD`,
      GSI1SK: 'STATUS#MASTERED#TARGET#frog',
      childId,
      activity: 'SIGHT_WORD',
      target: 'frog',
      status: 'MASTERED',
      attemptCount: 99,
      lastPracticedAt: 'stale',
      policyVersion: 0,
    });

    await handler({ rebuild: { childId } });

    expect(await getProgress(childId, 'frog')).toMatchObject({
      status: 'IN_PROGRESS',
      attemptCount: 1,
      policyVersion: POLICY_VERSION,
      GSI1SK: 'STATUS#IN_PROGRESS#TARGET#frog',
    });
  });

  it('rebuilds every child when no childId is given', async () => {
    const childA = randomUUID();
    const childB = randomUUID();
    await store(attemptItem(childA, 'frog', 0, 'SPELL', true));
    await store(attemptItem(childB, 'cat', 0, 'SPELL', true));

    const result = await handler({ rebuild: {} });

    // The shared test table also holds other tests' attempts.
    expect(result.rebuilt).toBeGreaterThanOrEqual(2);
    expect(await getProgress(childA, 'frog')).toMatchObject({ attemptCount: 1 });
    expect(await getProgress(childB, 'cat')).toMatchObject({ attemptCount: 1 });
  });

  it('rebuilds nothing for a child with no attempts', async () => {
    expect(await handler({ rebuild: { childId: randomUUID() } })).toEqual({ rebuilt: 0 });
  });
});
