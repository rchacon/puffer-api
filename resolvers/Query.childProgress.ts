import type { CognitoContext, Empty, Progress, ProgressStatus, Activity } from './lib/types.js';

// Pipeline resolver: functions/verifyChildOwnership.ts -> functions/queryChildProgress.ts
// Read by scripts/generate-appsync-template.mjs to know this is a PIPELINE
// resolver (not UNIT) and which functions to chain, in order.
export const pipelineFunctions = ['verifyChildOwnership', 'queryChildProgress'];

type Args = { childId: string; activity: Activity; status?: ProgressStatus | null };

// verifyChildOwnership reads the child from the stash (see Mutation.recordAttempt).
export function request(ctx: CognitoContext<Args, unknown, any, { childId: string }>): Empty {
  ctx.stash.childId = ctx.args.childId;
  return {};
}

export function response(ctx: CognitoContext<Empty, unknown, { result: Progress[] }>): Progress[] {
  return ctx.prev.result;
}
