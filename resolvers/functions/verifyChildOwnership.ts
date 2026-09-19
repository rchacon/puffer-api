import { util, type DynamoDBGetItemRequest } from '@aws-appsync/utils';
import { parentPk, childSk } from '../lib/keys.js';
import type { CognitoContext } from '../lib/types.js';

type Args = { childId: string };

export function request(ctx: CognitoContext<Args>): DynamoDBGetItemRequest {
  return {
    operation: 'GetItem',
    key: util.dynamodb.toMapValues({
      PK: parentPk(ctx.identity.sub),
      SK: childSk(ctx.args.childId),
    }),
  };
}

export function response(ctx: CognitoContext<Args, Record<string, unknown> | null>) {
  if (!ctx.result) {
    util.error(`Child ${ctx.args.childId} not found for this parent`, 'NotFound');
  }
  return ctx.result;
}
