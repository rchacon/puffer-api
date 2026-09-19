import type { Attempt, CognitoContext, Empty, RecordAttemptInput } from './lib/types.js';

// Pipeline resolver: functions/verifyChildOwnership.ts -> functions/findAttempt.ts
// -> functions/recordAttempt.ts
// Read by scripts/generate-appsync-template.mjs to know this is a PIPELINE
// resolver (not UNIT) and which functions to chain, in order.
export const pipelineFunctions = ['verifyChildOwnership', 'findAttempt', 'recordAttempt'];

// verifyChildOwnership is shared by every child-scoped pipeline resolver and
// can't know where each one nests `childId` in its args, so it reads it from
// the stash.
export function request(ctx: CognitoContext<{ input: RecordAttemptInput }, unknown, any, { childId: string }>): Empty {
  ctx.stash.childId = ctx.args.input.childId;
  return {};
}

export function response(ctx: CognitoContext<Empty, unknown, { result: Attempt }>): Attempt {
  return ctx.prev.result;
}
