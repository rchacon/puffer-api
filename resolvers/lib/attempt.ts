import type { Attempt, AttemptItem } from './types.js';

// Case/whitespace-insensitive comparison key for answers and options.
export function normalizeAnswer(s: string): string {
  return s.trim().toLowerCase();
}

// Drops the key/evidence attributes that aren't part of the GraphQL Attempt type.
export function toAttempt(item: AttemptItem): Attempt {
  return {
    id: item.id,
    childId: item.childId,
    activity: item.activity,
    target: item.target,
    challengeType: item.challengeType,
    correct: item.correct,
    occurredAt: item.occurredAt,
    receivedAt: item.receivedAt,
  };
}
