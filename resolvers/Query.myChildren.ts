import { util, type DynamoDBQueryRequest } from '@aws-appsync/utils';
import { parentPk } from './lib/keys.js';
import type { Child, CognitoContext } from './lib/types.js';

type ChildItem = { PK: string; SK: string; name: string; avatar: string | null; birthday: string; createdAt: string };
type QueryResult = { items: ChildItem[] };

export function request(ctx: CognitoContext): DynamoDBQueryRequest {
  return {
    operation: 'Query',
    query: {
      expression: 'PK = :pk AND begins_with(SK, :childPrefix)',
      expressionValues: util.dynamodb.toMapValues({
        ':pk': parentPk(ctx.identity.sub),
        ':childPrefix': 'CHILD#',
      }),
    },
  };
}

export function response(ctx: CognitoContext<Record<string, never>, Record<string, any>, QueryResult>): Child[] {
  if (ctx.error) {
    return util.error(ctx.error.message, ctx.error.type);
  }
  return ctx.result.items.map(({ PK, SK, ...rest }) => ({
    id: SK.slice('CHILD#'.length),
    parentId: ctx.identity.sub,
    ...rest,
  }));
}
