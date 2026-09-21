import type { ChallengeType, ProgressStatus } from '../../resolvers/lib/types.js';

// Bump whenever the rules below change, so summaries computed under an older
// rule can be found and rebuilt (see rebuildProgress in ./index.ts).
export const POLICY_VERSION = 1;

// The slice of a stored attempt that derivation needs.
export interface AttemptRecord {
  id: string;
  challengeType: ChallengeType;
  correct: boolean;
  occurredAt: string;
}

export interface DerivedProgress {
  status: ProgressStatus;
  attemptCount: number;
  lastPracticedAt: string;
  policyVersion: number;
}

const MS_PER_DAY = 24 * 60 * 60 * 1000;

// MASTERED: correct SPELL attempts on at least this many different UTC days...
const MASTERY_MIN_DAYS = 3;
// ...spanning at least this many days from the first to the last...
const MASTERY_MIN_SPAN_DAYS = 7;
// ...and this many of the most recent SPELL attempts must all be correct.
const MASTERY_RECENT_SPELLINGS = 2;

// NEEDS_SUPPORT: at least this many of the most recent attempts (of any
// challenge type) were wrong.
const SUPPORT_WINDOW = 3;
const SUPPORT_MISSES = 2;

// Days are UTC days, so the result depends on occurredAt alone.
function utcDay(occurredAt: string): number {
  return Math.floor(Date.parse(occurredAt) / MS_PER_DAY);
}

function byTime(a: AttemptRecord, b: AttemptRecord): number {
  if (a.occurredAt !== b.occurredAt) {
    return a.occurredAt < b.occurredAt ? -1 : 1;
  }
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

// `sorted` is chronological. Only SPELL attempts count: recognition
// (MULTIPLE_CHOICE) never establishes mastery, so it is ignored here.
function isMastered(sorted: AttemptRecord[]): boolean {
  const spellings = sorted.filter((a) => a.challengeType === 'SPELL');

  const recent = spellings.slice(-MASTERY_RECENT_SPELLINGS);
  if (recent.length < MASTERY_RECENT_SPELLINGS || !recent.every((a) => a.correct)) {
    return false;
  }

  const days = spellings.filter((a) => a.correct).map((a) => utcDay(a.occurredAt));
  if (new Set(days).size < MASTERY_MIN_DAYS) {
    return false;
  }
  // With at least three distinct days, "the third at least a week after the
  // first" holds for some choice of days exactly when the earliest and latest
  // correct days are far enough apart (any other day serves as the middle one).
  return Math.max(...days) - Math.min(...days) >= MASTERY_MIN_SPAN_DAYS;
}

function needsSupport(sorted: AttemptRecord[]): boolean {
  const misses = sorted.slice(-SUPPORT_WINDOW).filter((a) => !a.correct).length;
  return misses >= SUPPORT_MISSES;
}

// Derives a target's progress from its full attempt history, in any order.
// Pure and total over the history, so it can be re-run at any time (e.g. after
// the rules change) and always yields the same answer for the same attempts.
export function deriveProgress(attempts: AttemptRecord[]): DerivedProgress {
  if (attempts.length === 0) {
    throw new Error('deriveProgress needs at least one attempt');
  }
  const sorted = [...attempts].sort(byTime);
  const last = sorted[sorted.length - 1] as AttemptRecord;

  let status: ProgressStatus = 'IN_PROGRESS';
  if (isMastered(sorted)) {
    status = 'MASTERED';
  } else if (needsSupport(sorted)) {
    status = 'NEEDS_SUPPORT';
  }

  return {
    status,
    attemptCount: sorted.length,
    lastPracticedAt: last.occurredAt,
    policyVersion: POLICY_VERSION,
  };
}
