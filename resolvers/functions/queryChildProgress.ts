import { util, type DynamoDBQueryRequest } from '@aws-appsync/utils';
import { statusIndexPk } from '../lib/keys.js';
import type { Activity, CognitoContext, Progress, ProgressItem, ProgressStatus } from '../lib/types.js';

type Args = { childId: string; activity: Activity; status?: ProgressStatus | null };
type QueryResult = { items: ProgressItem[] };

// One child's progress summaries for an activity, optionally for one status,
// from GSI1 (grouped by status, then target).
export function request(ctx: CognitoContext<Args>): DynamoDBQueryRequest {
  const { childId, activity, status } = ctx.args;
  const expressionValues: Record<string, unknown> = { ':pk': statusIndexPk(childId, activity) };
  let expression = 'GSI1PK = :pk';

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

export function response(ctx: CognitoContext<Args, QueryResult>): Progress[] {
  if (ctx.error) {
    return util.error(ctx.error.message, ctx.error.type);
  }
  return ctx.result.items.map(({ childId, activity, target, status, attemptCount, lastPracticedAt }) => ({
    childId,
    activity,
    target,
    status,
    attemptCount,
    lastPracticedAt,
  }));
}
