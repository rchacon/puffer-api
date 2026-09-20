import type { Activity } from './types.js';

// Partition key shared by a parent's own profile item and all of their child
// items, so "parent + all children" is one Query on this PK (see myChildren).
export function parentPk(sub: string): string {
  return `PARENT#${sub}`;
}

// Sort key for the parent's own profile item within its PARENT# partition.
export function profileSk(): string {
  return 'PROFILE';
}

// Sort key for a child item within its parent's PARENT# partition. Combined
// with parentPk + begins_with(SK, 'CHILD#'), this is what myChildren queries.
export function childSk(childId: string): string {
  return `CHILD#${childId}`;
}

// Partition key for a child's own item collection (attempts), independent of
// the parent's partition -- enables per-child queries without touching the
// parent's data.
export function childPk(childId: string): string {
  return `CHILD#${childId}`;
}

// Sort key for an immutable attempt within its child's CHILD# partition.
// Activity + target come first so one target's full history (what the mastery
// rule will need) is a single begins_with Query, then occurredAt (canonical
// UTC ISO-8601, so it sorts chronologically) and attemptId, which makes a
// retried recordAttempt land on the same key instead of creating a duplicate.
export function attemptSk(activity: Activity, target: string, occurredAt: string, attemptId: string): string {
  return `ATTEMPT#${activity}#${target}#${occurredAt}#${attemptId}`;
}
