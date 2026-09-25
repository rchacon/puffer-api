import { util, type DynamoDBGetItemRequest } from '@aws-appsync/utils';
import { childPk, attemptSk } from '../lib/keys.js';
import { normalizeText } from '../lib/attempt.js';
import type { AttemptItem, AttemptStash, CognitoContext, RecordAttemptInput } from '../lib/types.js';

type Args = { input: RecordAttemptInput };

const MAX_TEXT_LENGTH = 64;
const MAX_OPTIONS = 12;

function invalid(message: string): never {
  return util.error(message, 'ValidationError');
}

// Validates the attempt, derives `correct` from the target (never from
// anything the caller asserts about correctness), and looks for an existing
// attempt with the same attemptId so recordAttempt can return it instead of
// writing a duplicate. occurredAt's window is checked later, in recordAttempt,
// and only for a new attempt: a retry of one already recorded must get the
// stored attempt back even if its timestamp has since aged out of the window.
export function request(ctx: CognitoContext<Args, unknown, any, Partial<AttemptStash>>): DynamoDBGetItemRequest {
  const { attemptId, target, challengeType, answer, presentedOptions } = ctx.args.input;

  // '#' delimits the segments of the keys built from these values.
  if (attemptId.length < 8 || attemptId.length > MAX_TEXT_LENGTH || attemptId.includes('#')) {
    invalid(`attemptId must be 8-${MAX_TEXT_LENGTH} characters and not contain '#'`);
  }
  if (answer.length > MAX_TEXT_LENGTH) {
    invalid(`answer must be at most ${MAX_TEXT_LENGTH} characters`);
  }

  // The target is stored, keyed and returned in its canonical form (the same
  // one `correct` is judged on), so "Cat", "cat" and " cat " are one word with
  // one history instead of three.
  const normalizedTarget = normalizeText(target);
  if (normalizedTarget.length < 1 || normalizedTarget.length > MAX_TEXT_LENGTH || normalizedTarget.includes('#')) {
    invalid(`target must be 1-${MAX_TEXT_LENGTH} characters after trimming and not contain '#'`);
  }

  const normalizedAnswer = normalizeText(answer);
  if (challengeType === 'MULTIPLE_CHOICE') {
    if (!presentedOptions || presentedOptions.length < 2 || presentedOptions.length > MAX_OPTIONS) {
      invalid(`presentedOptions must have 2-${MAX_OPTIONS} entries for MULTIPLE_CHOICE`);
    }
    const options = presentedOptions.map(normalizeText);
    if (presentedOptions.some((o) => o.length > MAX_TEXT_LENGTH)) {
      invalid(`each presented option must be at most ${MAX_TEXT_LENGTH} characters`);
    }
    if (!options.includes(normalizedTarget)) {
      invalid('presentedOptions must include the target');
    }
    if (!options.includes(normalizedAnswer)) {
      invalid('answer must be one of presentedOptions');
    }
  } else if (presentedOptions) {
    invalid(`presentedOptions is not allowed for ${challengeType}`);
  }

  ctx.stash.attempt = { target: normalizedTarget, correct: normalizedAnswer === normalizedTarget };

  return {
    operation: 'GetItem',
    key: util.dynamodb.toMapValues({ PK: childPk(ctx.args.input.childId), SK: attemptSk(attemptId) }),
    // Strongly consistent: a retry right after a write must see it.
    consistentRead: true,
  };
}

export function response(ctx: CognitoContext<Args, AttemptItem | null>): AttemptItem | null {
  // A failed read must not look like "no existing attempt", or the duplicate
  // check is silently skipped.
  if (ctx.error) {
    return util.error(ctx.error.message, ctx.error.type);
  }
  return ctx.result;
}
