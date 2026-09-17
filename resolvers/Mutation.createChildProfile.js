import { util } from '@aws-appsync/utils';
import { parentPk, childSk } from './lib/keys.js';

export function request(ctx) {
  const childId = util.autoId();
  const createdAt = util.time.nowISO8601();
  ctx.stash.childId = childId;
  ctx.stash.createdAt = createdAt;

  return {
    operation: 'PutItem',
    key: util.dynamodb.toMapValues({
      PK: parentPk(ctx.identity.sub),
      SK: childSk(childId),
    }),
    attributeValues: util.dynamodb.toMapValues({
      name: ctx.args.input.name,
      avatar: ctx.args.input.avatar ?? null,
      birthday: ctx.args.input.birthday,
      createdAt,
    }),
  };
}

export function response(ctx) {
  if (ctx.error) {
    return util.error(ctx.error.message, ctx.error.type);
  }
  return {
    id: ctx.stash.childId,
    parentId: ctx.identity.sub,
    name: ctx.args.input.name,
    avatar: ctx.args.input.avatar ?? null,
    birthday: ctx.args.input.birthday,
    createdAt: ctx.stash.createdAt,
  };
}
