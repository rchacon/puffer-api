import { util, type DynamoDBGetItemRequest } from '@aws-appsync/utils';
import { parentPk, childSk } from '../lib/keys.js';
import type { CognitoContext, Empty } from '../lib/types.js';

type Stash = { childId: string };

export function request(ctx: CognitoContext<Empty, unknown, any, Stash>): DynamoDBGetItemRequest {
  return {
    operation: 'GetItem',
    key: util.dynamodb.toMapValues({
      PK: parentPk(ctx.identity.sub),
      SK: childSk(ctx.stash.childId),
    }),
  };
}

export function response(ctx: CognitoContext<Empty, Record<string, unknown> | null, any, Stash>) {
  if (!ctx.result) {
    util.error(`Child ${ctx.stash.childId} not found for this parent`, 'NotFound');
  }
  return ctx.result;
}
