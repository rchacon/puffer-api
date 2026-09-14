import type { CognitoContext, WordProgress } from './lib/types.js';

// Pipeline resolver: functions/verifyChildOwnership.ts -> functions/queryChildWordProgress.ts
export function request(ctx: CognitoContext): Record<string, never> {
  return {};
}

export function response(ctx: CognitoContext<Record<string, never>, Record<string, any>, unknown, { result: WordProgress[] }>): WordProgress[] {
  return ctx.prev.result;
}
