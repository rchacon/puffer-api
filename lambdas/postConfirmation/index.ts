import type { PostConfirmationTriggerEvent } from 'aws-lambda';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, PutCommand } from '@aws-sdk/lib-dynamodb';
import { parentPk, profileSk } from '../../resolvers/lib/keys.js';
import { TABLE_NAME } from '../../lib/tableName.js';

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

export async function handler(
  event: PostConfirmationTriggerEvent
): Promise<PostConfirmationTriggerEvent> {
  // This trigger also fires for PostConfirmation_ConfirmForgotPassword, which
  // this Lambda has nothing to do -- the type is the full union so this check
  // is real narrowing, not a dead branch a future cleanup could remove.
  if (event.triggerSource !== 'PostConfirmation_ConfirmSignUp') {
    return event;
  }

  const { sub, email, name } = event.request.userAttributes;

  if (!sub) {
    throw new Error('PostConfirmation event is missing the sub attribute');
  }

  // Parent.email is non-null in schema.graphql; a missing email here means the
  // User Pool isn't configured to require/verify it, which is a config error
  // worth failing sign-up over rather than silently writing a broken profile
  // that only breaks later when myProfile is queried.
  if (!email) {
    throw new Error(`PostConfirmation event for sub ${sub} is missing the email attribute`);
  }

  try {
    await client.send(
      new PutCommand({
        TableName: TABLE_NAME,
        Item: {
          PK: parentPk(sub),
          SK: profileSk(),
          email,
          name: name ?? null,
          createdAt: new Date().toISOString(),
        },
        ConditionExpression: 'attribute_not_exists(PK)',
      })
    );
  } catch (err) {
    if (!(err instanceof Error) || err.name !== 'ConditionalCheckFailedException') {
      throw err;
    }
    // Parent profile already exists (duplicate trigger invocation) — no-op.
  }

  return event;
}
