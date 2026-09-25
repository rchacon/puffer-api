import { runtime, util, type DynamoDBPutItemRequest } from '@aws-appsync/utils';
import { childPk, attemptSk } from '../lib/keys.js';
import { toAttempt } from '../lib/attempt.js';
import type { Attempt, AttemptItem, AttemptStash, CognitoContext, RecordAttemptInput } from '../lib/types.js';

type Args = { input: RecordAttemptInput };

// A client may report an attempt made offline, but not one from the future or
// from long ago. Rejected rather than clamped so a bad clock is visible to the
// client instead of silently rewriting the history.
const MAX_FUTURE_MS = 5 * 60 * 1000;
const MAX_PAST_MS = 30 * 24 * 60 * 60 * 1000;

// Writes the immutable attempt item. Runs after prepareAttempt, which already
// validated the input and stashed the canonical target and `correct`.
export function request(
  ctx: CognitoContext<Args, unknown, { result: AttemptItem | null }, AttemptStash>
): DynamoDBPutItemRequest {
  const { attemptId, childId, activity, challengeType, answer, presentedOptions, occurredAt } = ctx.args.input;
  const { target, correct } = ctx.stash.attempt;

  // Retry of an attempt we already recorded: hand back the stored one, don't
  // write a second. attemptId is the attempt's identity, so a retry's
  // occurredAt is ignored (the stored attempt keeps its original time); the
  // same attemptId with different contents is a client bug.
  const existing = ctx.prev.result;
  if (existing) {
    if (
      existing.activity !== activity ||
      existing.target !== target ||
      existing.challengeType !== challengeType ||
      existing.answer !== answer ||
      JSON.stringify(existing.presentedOptions ?? null) !== JSON.stringify(presentedOptions ?? null)
    ) {
      util.error(`attemptId ${attemptId} was already used for a different attempt`, 'Conflict');
    }
    runtime.earlyReturn(toAttempt(existing));
  }

  const occurredAtMs = util.time.parseISO8601ToEpochMilliSeconds(occurredAt);
  const nowMs = util.time.nowEpochMilliSeconds();
  if (occurredAtMs > nowMs + MAX_FUTURE_MS || occurredAtMs < nowMs - MAX_PAST_MS) {
    util.error('occurredAt is outside the accepted window', 'ValidationError');
  }
  const canonicalOccurredAt = util.time.epochMilliSecondsToISO8601(occurredAtMs);

  const item: Record<string, unknown> = {
    id: attemptId,
    childId,
    activity,
    target,
    challengeType,
    answer,
    correct,
    occurredAt: canonicalOccurredAt,
    receivedAt: util.time.nowISO8601(),
  };
  if (presentedOptions) {
    item.presentedOptions = presentedOptions;
  }

  return {
    operation: 'PutItem',
    key: util.dynamodb.toMapValues({ PK: childPk(childId), SK: attemptSk(attemptId) }),
    attributeValues: util.dynamodb.toMapValues(item),
    // Guards the window between prepareAttempt's read and this write: a
    // concurrent duplicate fails here (the client's retry then hits the early
    // return above) instead of overwriting the stored attempt.
    condition: { expression: 'attribute_not_exists(PK)' },
  };
}

export function response(ctx: CognitoContext<Args, AttemptItem>): Attempt {
  if (ctx.error) {
    return util.error(ctx.error.message, ctx.error.type);
  }
  return toAttempt(ctx.result);
}
