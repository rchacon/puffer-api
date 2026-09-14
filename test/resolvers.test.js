import { randomUUID } from 'node:crypto';
import { beforeAll, describe, expect, it } from 'vitest';
import { PutItemCommand } from '@aws-sdk/client-dynamodb';
import { createTable } from '../scripts/create-table.js';
import {
  dynamoClient,
  marshall,
  runPipelineResolver,
  runUnitResolver,
  TABLE_NAME,
} from './dynamoResolverHarness.js';
import * as myProfile from '../resolvers/Query.myProfile.ts';
import * as myChildren from '../resolvers/Query.myChildren.ts';
import * as createChildProfile from '../resolvers/Mutation.createChildProfile.ts';
import * as verifyChildOwnership from '../resolvers/functions/verifyChildOwnership.ts';
import * as recordWordAttempt from '../resolvers/functions/recordWordAttempt.ts';
import * as queryChildWordProgress from '../resolvers/functions/queryChildWordProgress.ts';

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

describe('recordWordAttempt + childWordProgress (pipeline)', () => {
  it('records a word attempt and surfaces it via the status-filtered query', async () => {
    const parentSub = randomUUID();
    const child = await runUnitResolver(
      createChildProfile,
      ctxFor(parentSub, { input: { name: 'Rio' } })
    );

    const attempt1 = await runPipelineResolver(
      [verifyChildOwnership, recordWordAttempt],
      ctxFor(parentSub, { childId: child.id, word: 'whale', status: 'NEEDS_SUPPORT' })
    );
    expect(attempt1).toMatchObject({ word: 'whale', status: 'NEEDS_SUPPORT', attempts: 1 });

    // Second attempt on the same word increments attempts and can change status.
    const attempt2 = await runPipelineResolver(
      [verifyChildOwnership, recordWordAttempt],
      ctxFor(parentSub, { childId: child.id, word: 'whale', status: 'MASTERED' })
    );
    expect(attempt2).toMatchObject({ word: 'whale', status: 'MASTERED', attempts: 2 });

    await runPipelineResolver(
      [verifyChildOwnership, recordWordAttempt],
      ctxFor(parentSub, { childId: child.id, word: 'otter', status: 'NEEDS_SUPPORT' })
    );

    const needsSupport = await runPipelineResolver(
      [verifyChildOwnership, queryChildWordProgress],
      ctxFor(parentSub, { childId: child.id, status: 'NEEDS_SUPPORT' })
    );
    expect(needsSupport.map((w) => w.word)).toEqual(['otter']);

    const all = await runPipelineResolver(
      [verifyChildOwnership, queryChildWordProgress],
      ctxFor(parentSub, { childId: child.id })
    );
    expect(all.map((w) => w.word).sort()).toEqual(['otter', 'whale']);
  });

  it('rejects recording a word attempt against a child that is not the caller\'s', async () => {
    const owner = randomUUID();
    const attacker = randomUUID();
    const child = await runUnitResolver(
      createChildProfile,
      ctxFor(owner, { input: { name: 'Sam' } })
    );

    await expect(
      runPipelineResolver(
        [verifyChildOwnership, recordWordAttempt],
        ctxFor(attacker, { childId: child.id, word: 'whale', status: 'MASTERED' })
      )
    ).rejects.toThrow();
  });
});
