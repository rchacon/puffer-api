import { util, type DynamoDBPutItemRequest } from '@aws-appsync/utils';
import { parentPk, childSk } from './lib/keys.js';
import type { Child, CognitoContext } from './lib/types.js';

type Args = { input: { name: string; avatar?: string | null; birthday: string } };
type Stash = { childId: string; createdAt: string };

export function request(ctx: CognitoContext<Args, Partial<Stash>>): DynamoDBPutItemRequest {
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

export function response(ctx: CognitoContext<Args, Stash>): Child {
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
