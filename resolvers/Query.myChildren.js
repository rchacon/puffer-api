import { util } from '@aws-appsync/utils';
import { parentPk } from './lib/keys.js';

export function request(ctx) {
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

export function response(ctx) {
  return ctx.result.items.map(({ PK, SK, ...rest }) => ({
    id: SK.slice('CHILD#'.length),
    parentId: ctx.identity.sub,
    ...rest,
  }));
}
