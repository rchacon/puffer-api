import { randomUUID } from 'node:crypto';
import { beforeAll, describe, expect, it } from 'vitest';
import { PutItemCommand } from '@aws-sdk/client-dynamodb';
import { createTable } from '../scripts/create-table.js';
import { dynamoClient, marshall, runUnitResolver, TABLE_NAME } from './dynamoResolverHarness.js';
import * as myProfile from '../resolvers/Query.myProfile.js';
import * as myChildren from '../resolvers/Query.myChildren.js';
import * as createChildProfile from '../resolvers/Mutation.createChildProfile.js';

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
});
