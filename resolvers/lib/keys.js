// Partition key shared by a parent's own profile item and all of their child
// items, so "parent + all children" is one Query on this PK (see myChildren).
export function parentPk(sub) {
  return `PARENT#${sub}`;
}

// Sort key for the parent's own profile item within its PARENT# partition.
export function profileSk() {
  return 'PROFILE';
}

// Sort key for a child item within its parent's PARENT# partition. Combined
// with parentPk + begins_with(SK, 'CHILD#'), this is what myChildren queries.
export function childSk(childId) {
  return `CHILD#${childId}`;
}

// Partition key for a child's own item collection (word-progress items),
// independent of the parent's partition -- enables per-child queries like
// childWordProgress without touching the parent's data.
export function childPk(childId) {
  return `CHILD#${childId}`;
}
