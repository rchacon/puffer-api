import { randomUUID } from 'node:crypto';
import { beforeAll, describe, expect, it } from 'vitest';
import { GetItemCommand } from '@aws-sdk/client-dynamodb';
import { createTable } from '../../scripts/create-table.js';
import { dynamoClient, TABLE_NAME, unmarshall } from '../../test/dynamoResolverHarness.js';
import { handler } from './index.ts';

function confirmSignUpEvent(sub, email) {
  return {
    triggerSource: 'PostConfirmation_ConfirmSignUp',
    request: { userAttributes: { sub, email, name: 'Test Parent' } },
  };
}

beforeAll(async () => {
  await createTable();
});

describe('postConfirmation trigger', () => {
  it('upserts a parent profile item keyed by the Cognito sub', async () => {
    const sub = randomUUID();
    await handler(confirmSignUpEvent(sub, 'parent@example.com'));

    const { Item } = await dynamoClient.send(
      new GetItemCommand({
        TableName: TABLE_NAME,
        Key: { PK: { S: `PARENT#${sub}` }, SK: { S: 'PROFILE' } },
      })
    );
    expect(unmarshall(Item)).toMatchObject({ email: 'parent@example.com' });
  });

  it('is idempotent across duplicate trigger invocations', async () => {
    const sub = randomUUID();
    await handler(confirmSignUpEvent(sub, 'parent2@example.com'));
    await handler(confirmSignUpEvent(sub, 'parent2@example.com'));

    const { Item } = await dynamoClient.send(
      new GetItemCommand({
        TableName: TABLE_NAME,
        Key: { PK: { S: `PARENT#${sub}` }, SK: { S: 'PROFILE' } },
      })
    );
    expect(Item).toBeDefined();
  });

  it('ignores events from other trigger sources', async () => {
    const result = await handler({ triggerSource: 'PreSignUp_SignUp', request: {} });
    expect(result.triggerSource).toBe('PreSignUp_SignUp');
  });

  it('no-ops on PostConfirmation_ConfirmForgotPassword, the other real trigger source for this same hook', async () => {
    const sub = randomUUID();
    const event = {
      triggerSource: 'PostConfirmation_ConfirmForgotPassword',
      request: { userAttributes: { sub, email: 'parent@example.com' } },
    };
    const result = await handler(event);
    expect(result).toBe(event);

    const { Item } = await dynamoClient.send(
      new GetItemCommand({
        TableName: TABLE_NAME,
        Key: { PK: { S: `PARENT#${sub}` }, SK: { S: 'PROFILE' } },
      })
    );
    expect(Item).toBeUndefined();
  });

  it('throws when the email attribute is missing', async () => {
    const sub = randomUUID();
    await expect(
      handler({
        triggerSource: 'PostConfirmation_ConfirmSignUp',
        request: { userAttributes: { sub } },
      })
    ).rejects.toThrow(/email/i);
  });
});
