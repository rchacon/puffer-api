import type { CognitoContext, Empty, WordProgress } from './lib/types.js';

// Pipeline resolver: functions/verifyChildOwnership.ts -> functions/queryChildWordProgress.ts
// Read by scripts/generate-appsync-template.mjs to know this is a PIPELINE
// resolver (not UNIT) and which functions to chain, in order.
export const pipelineFunctions = ['verifyChildOwnership', 'queryChildWordProgress'];

export function request(ctx: CognitoContext): Empty {
  return {};
}

export function response(ctx: CognitoContext<Empty, unknown, { result: WordProgress[] }>): WordProgress[] {
  return ctx.prev.result;
}
