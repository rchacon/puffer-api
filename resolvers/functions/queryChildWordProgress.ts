import { util, type DynamoDBQueryRequest } from '@aws-appsync/utils';
import { childPk } from '../lib/keys.js';
import type { CognitoContext, WordProgress, WordStatus } from '../lib/types.js';

type Args = { childId: string; status?: WordStatus | null };
type WordItem = { PK: string; SK: string; GSI1PK: string; GSI1SK: string; status: WordStatus; attempts: number; lastPracticedAt: string };
type QueryResult = { items: WordItem[] };

export function request(ctx: CognitoContext<Args>): DynamoDBQueryRequest {
  const { childId, status } = ctx.args;
  const expressionValues: Record<string, unknown> = { ':gsi1pk': childPk(childId) };
  let expression = 'GSI1PK = :gsi1pk';

  if (status) {
    expression += ' AND begins_with(GSI1SK, :statusPrefix)';
    expressionValues[':statusPrefix'] = `STATUS#${status}#`;
  }

  return {
    operation: 'Query',
    index: 'GSI1',
    query: {
      expression,
      expressionValues: util.dynamodb.toMapValues(expressionValues),
    },
  };
}

export function response(ctx: CognitoContext<Args, QueryResult>): WordProgress[] {
  return ctx.result.items.map(({ PK, SK, GSI1PK, GSI1SK, ...rest }) => ({
    childId: ctx.args.childId,
    word: SK.slice('WORD#'.length),
    ...rest,
  }));
}
