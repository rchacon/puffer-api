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

// Partition key for a child's own item collection (attempts and progress
// summaries), independent of the parent's partition -- enables per-child
// queries without touching the parent's data.
export function childPk(childId: string): string {
  return `CHILD#${childId}`;
}

// Sort key for an immutable attempt within its child's CHILD# partition. The
// attemptId alone identifies the attempt, so recording it twice -- even with a
// different occurredAt -- lands on the same key and can be detected.
export function attemptSk(attemptId: string): string {
  return `ATTEMPT#${attemptId}`;
}

// GSI1 partition key holding every attempt at one target, so a target's full
// history (what progress derivation needs) is a single Query on GSI1.
export function attemptHistoryPk(childId: string, activity: Activity, target: string): string {
  return `CHILD#${childId}#ACTIVITY#${activity}#TARGET#${target}`;
}

// GSI1 sort key within an attempt-history partition: chronological, with the
// attemptId to keep attempts at the same instant distinct.
export function attemptHistorySk(occurredAt: string, attemptId: string): string {
  return `${occurredAt}#${attemptId}`;
}
