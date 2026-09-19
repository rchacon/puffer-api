import { util, type DynamoDBUpdateItemRequest } from '@aws-appsync/utils';
import { childPk, wordSk, statusIndexKey } from '../lib/keys.js';
import type { CognitoContext, WordProgress, WordStatus } from '../lib/types.js';

type Args = { childId: string; word: string; status: WordStatus };
type WordItem = { PK: string; SK: string; GSI1PK: string; GSI1SK: string; status: WordStatus; attempts: number; lastPracticedAt: string };

export function request(ctx: CognitoContext<Args>): DynamoDBUpdateItemRequest {
  const now = util.time.nowISO8601();
  return {
    operation: 'UpdateItem',
    key: util.dynamodb.toMapValues({
      PK: childPk(ctx.args.childId),
      SK: wordSk(ctx.args.word),
    }),
    update: {
      expression:
        'SET #status = :status, lastPracticedAt = :now, attempts = if_not_exists(attempts, :zero) + :one, ' +
        'GSI1PK = :gsi1pk, GSI1SK = :gsi1sk',
      expressionNames: { '#status': 'status' },
      expressionValues: util.dynamodb.toMapValues({
        ':status': ctx.args.status,
        ':now': now,
        ':zero': 0,
        ':one': 1,
        ':gsi1pk': childPk(ctx.args.childId),
        ':gsi1sk': statusIndexKey(ctx.args.status, ctx.args.word),
      }),
    },
  };
}

export function response(ctx: CognitoContext<Args, WordItem>): WordProgress {
  const { PK, SK, GSI1PK, GSI1SK, ...rest } = ctx.result;
  return { childId: ctx.args.childId, word: ctx.args.word, ...rest };
}
