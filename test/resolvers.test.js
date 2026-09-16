import { randomUUID } from 'node:crypto';
import { beforeAll, describe, expect, it } from 'vitest';
import { PutItemCommand } from '@aws-sdk/client-dynamodb';
import { createTable } from '../scripts/create-table.js';
import { dynamoClient, marshall, runUnitResolver, TABLE_NAME } from './dynamoResolverHarness.js';
import * as myProfile from '../resolvers/Query.myProfile.js';

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
