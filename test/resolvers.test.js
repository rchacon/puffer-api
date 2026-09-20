import { randomUUID } from 'node:crypto';
import { beforeAll, describe, expect, it } from 'vitest';
import { PutItemCommand, QueryCommand } from '@aws-sdk/client-dynamodb';
import { createTable } from '../scripts/create-table.js';
import {
  dynamoClient,
  marshall,
  unmarshall,
  runPipelineResolver,
  runUnitResolver,
  TABLE_NAME,
} from './dynamoResolverHarness.js';
import * as myProfile from '../resolvers/Query.myProfile.ts';
import * as myChildren from '../resolvers/Query.myChildren.ts';
import * as createChildProfile from '../resolvers/Mutation.createChildProfile.ts';
import * as verifyChildOwnership from '../resolvers/functions/verifyChildOwnership.ts';
import * as recordAttemptMutation from '../resolvers/Mutation.recordAttempt.ts';
import * as prepareAttempt from '../resolvers/functions/prepareAttempt.ts';
import * as recordAttempt from '../resolvers/functions/recordAttempt.ts';

function ctxFor(sub, args = {}) {
  return { identity: { sub }, args, stash: {} };
}

beforeAll(async () => {
  await createTable();
});

describe('myProfile', () => {
  it('returns null when no parent profile item exists yet', async () => {
    const result = await runUnitResolver(myProfile, ctxFor(randomUUID()));
    expect(result).toBeNull();
  });

  it('returns the parent profile when it exists', async () => {
    const sub = randomUUID();
    await dynamoClient.send(
      new PutItemCommand({
        TableName: TABLE_NAME,
        Item: marshall({
          PK: `PARENT#${sub}`,
          SK: 'PROFILE',
          email: 'parent@example.com',
          name: 'Test Parent',
          createdAt: new Date().toISOString(),
        }),
      })
    );

    const result = await runUnitResolver(myProfile, ctxFor(sub));
    expect(result).toMatchObject({
      id: sub,
      email: 'parent@example.com',
      name: 'Test Parent',
    });
  });
});

describe('createChildProfile + myChildren', () => {
  it('creates a child under the caller and lists it back', async () => {
    const parentSub = randomUUID();

    const created = await runUnitResolver(
      createChildProfile,
      ctxFor(parentSub, { input: { name: 'Ada', avatar: 'fox', birthday: '2019-04-12' } })
    );
    expect(created.name).toBe('Ada');
    expect(created.parentId).toBe(parentSub);
    expect(created.birthday).toBe('2019-04-12');

    const children = await runUnitResolver(myChildren, ctxFor(parentSub));
    expect(children).toHaveLength(1);
    expect(children[0]).toMatchObject({
      id: created.id,
      name: 'Ada',
      avatar: 'fox',
      birthday: '2019-04-12',
    });
  });

  it('does not see another parent\'s children', async () => {
    const parentA = randomUUID();
    const parentB = randomUUID();

    await runUnitResolver(
      createChildProfile,
      ctxFor(parentA, { input: { name: 'Grace', birthday: '2018-11-03' } })
    );

    const childrenForB = await runUnitResolver(myChildren, ctxFor(parentB));
    expect(childrenForB).toHaveLength(0);
  });

  it('createChildProfile.response surfaces a failed data source call instead of fabricating success', () => {
    const ctx = {
      ...ctxFor(randomUUID(), { input: { name: 'Ada', birthday: '2019-04-12' } }),
      error: { message: 'ProvisionedThroughputExceededException', type: 'DynamoDB:ProvisionedThroughputExceededException' },
    };
    expect(() => createChildProfile.response(ctx)).toThrow('ProvisionedThroughputExceededException');
  });

  it('myChildren.response surfaces a failed data source call instead of crashing on ctx.result', () => {
    const ctx = {
      ...ctxFor(randomUUID()),
      error: { message: 'ProvisionedThroughputExceededException', type: 'DynamoDB:ProvisionedThroughputExceededException' },
    };
    expect(() => myChildren.response(ctx)).toThrow('ProvisionedThroughputExceededException');
  });
});

describe('recordAttempt (pipeline)', () => {
  const pipeline = [verifyChildOwnership, prepareAttempt, recordAttempt];

  async function newChild(parentSub) {
    return runUnitResolver(createChildProfile, ctxFor(parentSub, { input: { name: 'Rio' } }));
  }

  function attemptInput(childId, overrides = {}) {
    return {
      attemptId: randomUUID(),
      childId,
      activity: 'SIGHT_WORD',
      target: 'whale',
      challengeType: 'SPELL',
      answer: 'whale',
      occurredAt: new Date().toISOString(),
      ...overrides,
    };
  }

  function record(parentSub, input) {
    return runPipelineResolver(pipeline, ctxFor(parentSub, { input }), recordAttemptMutation);
  }

  async function storedAttempts(childId) {
    const { Items } = await dynamoClient.send(
      new QueryCommand({
        TableName: TABLE_NAME,
        KeyConditionExpression: 'PK = :pk AND begins_with(SK, :prefix)',
        ExpressionAttributeValues: marshall({ ':pk': `CHILD#${childId}`, ':prefix': 'ATTEMPT#' }),
      })
    );
    return Items ?? [];
  }

  it('judges correctness server-side and keeps the attempt as evidence', async () => {
    const parentSub = randomUUID();
    const child = await newChild(parentSub);

    const right = await record(parentSub, attemptInput(child.id, { answer: '  Whale ' }));
    expect(right).toMatchObject({ childId: child.id, target: 'whale', challengeType: 'SPELL', correct: true });

    const wrong = await record(
      parentSub,
      attemptInput(child.id, {
        challengeType: 'MULTIPLE_CHOICE',
        answer: 'otter',
        presentedOptions: ['whale', 'otter', 'seal'],
      })
    );
    expect(wrong.correct).toBe(false);
    expect(wrong.receivedAt).toEqual(expect.any(String));

    const items = await storedAttempts(child.id);
    expect(items).toHaveLength(2);
    const stored = items.map((i) => ({ ...unmarshall(i) }));
    expect(stored.find((i) => i.id === wrong.id)).toMatchObject({
      answer: 'otter',
      presentedOptions: ['whale', 'otter', 'seal'],
    });
  });

  it('keys and stores the canonical target so spelling variants share one history', async () => {
    const parentSub = randomUUID();
    const child = await newChild(parentSub);

    const a = await record(parentSub, attemptInput(child.id, { target: 'Cat', answer: 'cat' }));
    const b = await record(parentSub, attemptInput(child.id, { target: ' cat ', answer: 'CAT' }));

    expect(a).toMatchObject({ target: 'cat', correct: true });
    expect(b).toMatchObject({ target: 'cat', correct: true });
    const items = (await storedAttempts(child.id)).map((i) => unmarshall(i));
    expect(items).toHaveLength(2);
    expect(items.every((i) => i.SK.startsWith('ATTEMPT#SIGHT_WORD#cat#'))).toBe(true);
    expect(items.every((i) => i.target === 'cat')).toBe(true);
  });

  it('is idempotent: retrying the same attempt returns the stored one without a duplicate', async () => {
    const parentSub = randomUUID();
    const child = await newChild(parentSub);
    const input = attemptInput(child.id);

    const first = await record(parentSub, input);
    const retry = await record(parentSub, input);

    expect(retry).toEqual(first);
    expect(await storedAttempts(child.id)).toHaveLength(1);
  });

  it('treats equivalent occurredAt spellings as the same attempt', async () => {
    const parentSub = randomUUID();
    const child = await newChild(parentSub);
    const at = new Date(Date.now() - 60_000);
    const input = attemptInput(child.id, { occurredAt: at.toISOString() });

    const first = await record(parentSub, input);
    const retry = await record(parentSub, { ...input, occurredAt: at.toISOString().replace('Z', '+00:00') });

    expect(retry).toEqual(first);
    expect(await storedAttempts(child.id)).toHaveLength(1);
  });

  it('rejects reusing an attemptId with different presented options', async () => {
    const parentSub = randomUUID();
    const child = await newChild(parentSub);
    const input = attemptInput(child.id, {
      challengeType: 'MULTIPLE_CHOICE',
      answer: 'whale',
      presentedOptions: ['whale', 'otter'],
    });

    await record(parentSub, input);
    await expect(
      record(parentSub, { ...input, presentedOptions: ['whale', 'seal'] })
    ).rejects.toThrow('already used');
    await expect(record(parentSub, { ...input, presentedOptions: ['otter', 'whale'] })).rejects.toThrow('already used');
    expect(await record(parentSub, input)).toMatchObject({ target: 'whale', correct: true });
    expect(await storedAttempts(child.id)).toHaveLength(1);
  });

  it('rejects reusing an attemptId for a different answer', async () => {
    const parentSub = randomUUID();
    const child = await newChild(parentSub);
    const input = attemptInput(child.id);

    await record(parentSub, input);
    await expect(record(parentSub, { ...input, answer: 'wale' })).rejects.toThrow('already used');
  });

  it.each([
    ['multiple choice without options', { challengeType: 'MULTIPLE_CHOICE', answer: 'whale' }, 'presentedOptions'],
    [
      'options missing the target',
      { challengeType: 'MULTIPLE_CHOICE', answer: 'otter', presentedOptions: ['otter', 'seal'] },
      'include the target',
    ],
    [
      'answer not among the options',
      { challengeType: 'MULTIPLE_CHOICE', answer: 'crab', presentedOptions: ['whale', 'otter'] },
      'one of presentedOptions',
    ],
    ['spell with options', { presentedOptions: ['whale', 'otter'] }, 'not allowed'],
    ['target containing #', { target: 'wha#le' }, 'target'],
    ['whitespace-only target', { target: '   ', answer: '' }, 'target'],
    ['short attemptId', { attemptId: 'abc' }, 'attemptId'],
    ['occurredAt in the future', { occurredAt: new Date(Date.now() + 3_600_000).toISOString() }, 'window'],
    ['occurredAt too old', { occurredAt: new Date(Date.now() - 40 * 86_400_000).toISOString() }, 'window'],
  ])('rejects invalid input: %s', async (_name, overrides, message) => {
    const parentSub = randomUUID();
    const child = await newChild(parentSub);

    await expect(record(parentSub, attemptInput(child.id, overrides))).rejects.toThrow(message);
    expect(await storedAttempts(child.id)).toHaveLength(0);
  });

  it.each([
    ['verifyChildOwnership', verifyChildOwnership],
    ['prepareAttempt', prepareAttempt],
    ['recordAttempt', recordAttempt],
  ])('%s.response surfaces a failed data source call instead of masking it', (_name, fn) => {
    const ctx = {
      ...ctxFor(randomUUID(), { input: attemptInput('child-1') }),
      stash: { childId: 'child-1' },
      result: null,
      error: { message: 'ProvisionedThroughputExceededException', type: 'DynamoDB:ProvisionedThroughputExceededException' },
    };
    expect(() => fn.response(ctx)).toThrow('ProvisionedThroughputExceededException');
  });

  it('rejects recording an attempt against a child that is not the caller\'s', async () => {
    const owner = randomUUID();
    const attacker = randomUUID();
    const child = await newChild(owner);

    await expect(record(attacker, attemptInput(child.id))).rejects.toThrow('not found');
    expect(await storedAttempts(child.id)).toHaveLength(0);
  });
});
