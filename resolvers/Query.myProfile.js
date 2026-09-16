import { util } from '@aws-appsync/utils';
import { parentPk, profileSk } from './lib/keys.js';

export function request(ctx) {
  return {
    operation: 'GetItem',
    key: util.dynamodb.toMapValues({
      PK: parentPk(ctx.identity.sub),
      SK: profileSk(),
    }),
  };
}

export function response(ctx) {
  if (!ctx.result) {
    return null;
  }
  const { PK, SK, ...rest } = ctx.result;
  return { id: ctx.identity.sub, ...rest };
}
