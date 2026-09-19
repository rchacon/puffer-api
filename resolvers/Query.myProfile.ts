import { util, type DynamoDBGetItemRequest } from '@aws-appsync/utils';
import { parentPk, profileSk } from './lib/keys.js';
import type { CognitoContext, Empty, Parent } from './lib/types.js';

type ParentItem = { PK: string; SK: string; email: string; name: string | null; createdAt: string };

export function request(ctx: CognitoContext): DynamoDBGetItemRequest {
  return {
    operation: 'GetItem',
    key: util.dynamodb.toMapValues({
      PK: parentPk(ctx.identity.sub),
      SK: profileSk(),
    }),
  };
}

export function response(ctx: CognitoContext<Empty, Record<string, any>, ParentItem | null>): Parent | null {
  if (!ctx.result) {
    return null;
  }
  const { PK, SK, ...rest } = ctx.result;
  return { id: ctx.identity.sub, ...rest };
}
