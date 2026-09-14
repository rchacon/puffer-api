export function parentPk(sub) {
  return `PARENT#${sub}`;
}

export function profileSk() {
  return 'PROFILE';
}

export function childSk(childId) {
  return `CHILD#${childId}`;
}

export function childPk(childId) {
  return `CHILD#${childId}`;
}
