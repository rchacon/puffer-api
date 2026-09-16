import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, PutCommand } from '@aws-sdk/lib-dynamodb';

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

const TABLE_NAME = process.env.TABLE_NAME ?? 'PufferPanicTable';

export async function handler(event) {
  if (event.triggerSource !== 'PostConfirmation_ConfirmSignUp') {
    return event;
  }

  const { sub, email, name } = event.request.userAttributes;

  try {
    await client.send(
      new PutCommand({
        TableName: TABLE_NAME,
        Item: {
          PK: `PARENT#${sub}`,
          SK: 'PROFILE',
          email: email ?? null,
          name: name ?? null,
          createdAt: new Date().toISOString(),
        },
        ConditionExpression: 'attribute_not_exists(PK)',
      })
    );
  } catch (err) {
    if (err.name !== 'ConditionalCheckFailedException') {
      throw err;
    }
    // Parent profile already exists (duplicate trigger invocation) — no-op.
  }

  return event;
}
