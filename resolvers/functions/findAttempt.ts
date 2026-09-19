import { util, type DynamoDBGetItemRequest } from '@aws-appsync/utils';
import { childPk, attemptSk } from '../lib/keys.js';
import { normalizeAnswer } from '../lib/attempt.js';
import type { AttemptItem, AttemptStash, CognitoContext, RecordAttemptInput } from '../lib/types.js';

type Args = { input: RecordAttemptInput };

const MAX_TEXT_LENGTH = 64;
const MAX_OPTIONS = 12;
// A client may report an attempt made offline, but not one from the future or
// from long ago. Rejected rather than clamped so the same request always maps
// to the same attempt key, which is what makes a retry idempotent.
const MAX_FUTURE_MS = 5 * 60 * 1000;
const MAX_PAST_MS = 30 * 24 * 60 * 60 * 1000;

function invalid(message: string): never {
  return util.error(message, 'ValidationError');
}

// Validates the attempt, derives `correct` from the target (never from
// anything the caller asserts about correctness), and looks for an existing
// attempt with the same key so recordAttempt can return it instead of writing
// a duplicate.
export function request(ctx: CognitoContext<Args, unknown, any, Partial<AttemptStash>>): DynamoDBGetItemRequest {
  const { attemptId, activity, target, challengeType, selectedAnswer, presentedOptions, occurredAt } = ctx.args.input;

  // '#' delimits the attempt sort key's segments, so it can't appear in them.
  if (attemptId.length < 8 || attemptId.length > MAX_TEXT_LENGTH || attemptId.includes('#')) {
    invalid(`attemptId must be 8-${MAX_TEXT_LENGTH} characters and not contain '#'`);
  }
  if (target.length < 1 || target.length > MAX_TEXT_LENGTH || target.includes('#')) {
    invalid(`target must be 1-${MAX_TEXT_LENGTH} characters and not contain '#'`);
  }
  if (selectedAnswer.length > MAX_TEXT_LENGTH) {
    invalid(`selectedAnswer must be at most ${MAX_TEXT_LENGTH} characters`);
  }

  const normalizedTarget = normalizeAnswer(target);
  const answer = normalizeAnswer(selectedAnswer);
  if (challengeType === 'CHOOSE_FROM_BANK') {
    if (!presentedOptions || presentedOptions.length < 2 || presentedOptions.length > MAX_OPTIONS) {
      invalid(`presentedOptions must have 2-${MAX_OPTIONS} entries for CHOOSE_FROM_BANK`);
    }
    const options = presentedOptions.map(normalizeAnswer);
    if (presentedOptions.some((o) => o.length > MAX_TEXT_LENGTH)) {
      invalid(`each presented option must be at most ${MAX_TEXT_LENGTH} characters`);
    }
    if (!options.includes(normalizedTarget)) {
      invalid('presentedOptions must include the target');
    }
    if (!options.includes(answer)) {
      invalid('selectedAnswer must be one of presentedOptions');
    }
  } else if (presentedOptions) {
    invalid(`presentedOptions is not allowed for ${challengeType}`);
  }

  const occurredAtMs = util.time.parseISO8601ToEpochMilliSeconds(occurredAt);
  const nowMs = util.time.nowEpochMilliSeconds();
  if (occurredAtMs > nowMs + MAX_FUTURE_MS || occurredAtMs < nowMs - MAX_PAST_MS) {
    invalid('occurredAt is outside the accepted window');
  }
  // Canonical UTC form, so equivalent inputs ("...+00:00" vs "...Z") share a key.
  const canonicalOccurredAt = util.time.epochMilliSecondsToISO8601(occurredAtMs);

  const sk = attemptSk(activity, target, canonicalOccurredAt, attemptId);
  ctx.stash.attempt = { sk, occurredAt: canonicalOccurredAt, correct: answer === normalizedTarget };

  return {
    operation: 'GetItem',
    key: util.dynamodb.toMapValues({ PK: childPk(ctx.args.input.childId), SK: sk }),
    // Strongly consistent: a retry right after a write must see it.
    consistentRead: true,
  };
}

export function response(ctx: CognitoContext<Args, AttemptItem | null>): AttemptItem | null {
  return ctx.result;
}
