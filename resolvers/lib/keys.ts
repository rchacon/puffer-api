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

// Partition key for a child's own item collection (word-progress items),
// independent of the parent's partition -- enables per-child queries like
// childWordProgress without touching the parent's data.
export function childPk(childId: string): string {
  return `CHILD#${childId}`;
}

// Sort key for a word-progress item within its child's CHILD# partition.
// Combined with childPk, this is what recordWordAttempt Gets/Updates.
export function wordSk(word: string): string {
  return `WORD#${word}`;
}

// GSI1SK value for a word-progress item, sorted by status then word. Lets
// queryChildWordProgress filter to one status via begins_with(GSI1SK, ...)
// instead of scanning and filtering all of a child's words.
export function statusIndexKey(status: string, word: string): string {
  return `STATUS#${status}#WORD#${word}`;
}
