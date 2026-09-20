import { runtime, util, type DynamoDBPutItemRequest } from '@aws-appsync/utils';
import { childPk } from '../lib/keys.js';
import { toAttempt } from '../lib/attempt.js';
import type { Attempt, AttemptItem, AttemptStash, CognitoContext, RecordAttemptInput } from '../lib/types.js';

type Args = { input: RecordAttemptInput };

// Writes the immutable attempt item. Runs after prepareAttempt, which already
// validated the input and stashed the key and `correct`.
export function request(
  ctx: CognitoContext<Args, unknown, { result: AttemptItem | null }, AttemptStash>
): DynamoDBPutItemRequest {
  const { attemptId, childId, activity, target, challengeType, answer, presentedOptions } = ctx.args.input;

  // Retry of an attempt we already recorded: hand back the stored one, don't
  // write a second. The same attemptId with different contents is a client bug.
  const existing = ctx.prev.result;
  if (existing) {
    if (existing.answer !== answer || existing.challengeType !== challengeType) {
      util.error(`attemptId ${attemptId} was already used for a different attempt`, 'Conflict');
    }
    runtime.earlyReturn(toAttempt(existing));
  }

  const { sk, occurredAt, correct } = ctx.stash.attempt;
  const item: Record<string, unknown> = {
    id: attemptId,
    childId,
    activity,
    target,
    challengeType,
    answer,
    correct,
    occurredAt,
    receivedAt: util.time.nowISO8601(),
  };
  if (presentedOptions) {
    item.presentedOptions = presentedOptions;
  }

  return {
    operation: 'PutItem',
    key: util.dynamodb.toMapValues({ PK: childPk(childId), SK: sk }),
    attributeValues: util.dynamodb.toMapValues(item),
    // Guards the window between prepareAttempt's read and this write: a
    // concurrent duplicate fails here (the client's retry then hits the
    // early return above) instead of overwriting the stored attempt.
    condition: { expression: 'attribute_not_exists(PK)' },
  };
}

export function response(ctx: CognitoContext<Args, AttemptItem>): Attempt {
  if (ctx.error) {
    return util.error(ctx.error.message, ctx.error.type);
  }
  return toAttempt(ctx.result);
}
