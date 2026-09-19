import type { CognitoContext, Empty, WordProgress } from './lib/types.js';

// Pipeline resolver: functions/verifyChildOwnership.ts -> functions/recordWordAttempt.ts
// Read by scripts/generate-appsync-template.mjs to know this is a PIPELINE
// resolver (not UNIT) and which functions to chain, in order.
export const pipelineFunctions = ['verifyChildOwnership', 'recordWordAttempt'];

export function request(ctx: CognitoContext): Empty {
  return {};
}

export function response(ctx: CognitoContext<Empty, Record<string, any>, unknown, { result: WordProgress }>): WordProgress {
  return ctx.prev.result;
}
