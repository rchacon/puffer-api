import { describe, expect, it } from 'vitest';
import { deriveProgress, POLICY_VERSION } from './derive.ts';

const DAY = 24 * 60 * 60 * 1000;
const START = Date.UTC(2026, 0, 1, 12, 0, 0);

let n = 0;
// An attempt `day` days after a fixed start (noon UTC), unless `at` gives an exact time.
function attempt(day, challengeType, correct, at) {
  n += 1;
  return {
    id: `attempt-${String(n).padStart(4, '0')}`,
    challengeType,
    correct,
    occurredAt: new Date(at ?? START + day * DAY).toISOString(),
  };
}
const spell = (day, correct = true) => attempt(day, 'SPELL', correct);
const choose = (day, correct = true) => attempt(day, 'MULTIPLE_CHOICE', correct);

const status = (attempts) => deriveProgress(attempts).status;

describe('deriveProgress: counts and bookkeeping', () => {
  it('counts attempts, reports the latest time and the policy version', () => {
    const latest = spell(5);
    const result = deriveProgress([choose(2), latest, choose(1)]);
    expect(result).toEqual({
      status: 'IN_PROGRESS',
      attemptCount: 3,
      lastPracticedAt: new Date(START + 5 * DAY).toISOString(),
      lastAttemptKey: `${latest.occurredAt}#${latest.id}`,
      policyVersion: POLICY_VERSION,
    });
  });

  it('is independent of the order attempts are given in', () => {
    const attempts = [spell(0), spell(3), spell(7), spell(8, false), choose(2)];
    const shuffled = [attempts[3], attempts[0], attempts[4], attempts[2], attempts[1]];
    expect(deriveProgress(shuffled)).toEqual(deriveProgress(attempts));
  });

  it('breaks ties between attempts at the same instant by id', () => {
    const at = START;
    const a = { id: 'a-1', challengeType: 'SPELL', correct: false, occurredAt: new Date(at).toISOString() };
    const b = { id: 'b-1', challengeType: 'SPELL', correct: true, occurredAt: new Date(at).toISOString() };
    expect(deriveProgress([b, a])).toEqual(deriveProgress([a, b]));
  });

  it('rejects an empty history', () => {
    expect(() => deriveProgress([])).toThrow('at least one attempt');
  });
});

describe('deriveProgress: MASTERED', () => {
  it('needs three correct spellings on three days, the third a week after the first', () => {
    expect(status([spell(0), spell(3), spell(7)])).toBe('MASTERED');
  });

  it('is not reached when the span is one day short of a week', () => {
    expect(status([spell(0), spell(3), spell(6)])).toBe('IN_PROGRESS');
  });

  it('is not reached with fewer than three different days', () => {
    expect(status([spell(0), spell(7)])).toBe('IN_PROGRESS');
    expect(status([spell(0), spell(0), spell(7), spell(7)])).toBe('IN_PROGRESS');
  });

  it('is not reached by many correct spellings on one day', () => {
    expect(status([spell(0), spell(0), spell(0), spell(0)])).toBe('IN_PROGRESS');
  });

  it('counts extra days: any spread of three days spanning a week qualifies', () => {
    expect(status([spell(0), spell(1), spell(2), spell(9)])).toBe('MASTERED');
  });

  it('uses UTC days: attempts either side of midnight are different days', () => {
    const lateEvening = Date.UTC(2026, 0, 1, 23, 59, 0);
    const justAfterMidnight = Date.UTC(2026, 0, 2, 0, 1, 0);
    const weekLater = Date.UTC(2026, 0, 9, 0, 30, 0);
    expect(
      status([
        attempt(0, 'SPELL', true, lateEvening),
        attempt(0, 'SPELL', true, justAfterMidnight),
        attempt(0, 'SPELL', true, weekLater),
      ])
    ).toBe('MASTERED');
    // Same two evenings-apart attempts but the last is only 6 UTC days after the first.
    expect(
      status([
        attempt(0, 'SPELL', true, lateEvening),
        attempt(0, 'SPELL', true, justAfterMidnight),
        attempt(0, 'SPELL', true, Date.UTC(2026, 0, 7, 12, 0, 0)),
      ])
    ).toBe('IN_PROGRESS');
  });

  it('ignores recognition attempts, however many', () => {
    expect(status([choose(0), choose(3), choose(7), choose(10)])).toBe('IN_PROGRESS');
  });

  it('does not count recognition days toward the spelling days', () => {
    expect(status([spell(0), choose(3), spell(7)])).toBe('IN_PROGRESS');
  });

  it('requires the two most recent spellings to be correct', () => {
    const base = [spell(0), spell(3), spell(7)];
    expect(status([...base, spell(8, false)])).toBe('IN_PROGRESS');
    // One correct spelling after a miss is not enough...
    expect(status([...base, spell(8, false), spell(9)])).toBe('IN_PROGRESS');
    // ...two are.
    expect(status([...base, spell(8, false), spell(9), spell(10)])).toBe('MASTERED');
  });

  it('is not lost by recognition misses that leave the two latest spellings correct', () => {
    expect(status([spell(0), spell(3), spell(7), choose(8, false), choose(9, false)])).toBe('MASTERED');
  });

  it('only counts correct spellings toward the days', () => {
    // A miss on day 0 doesn't count as a day: the correct days are 3, 7 and 10,
    // which span exactly a week.
    expect(status([spell(0, false), spell(3), spell(7), spell(10)])).toBe('MASTERED');
    // Without the day-10 attempt there are only two correct days.
    expect(status([spell(0, false), spell(3), spell(7)])).toBe('IN_PROGRESS');
  });
});

describe('deriveProgress: NEEDS_SUPPORT', () => {
  it('flags a word missed at least twice in the last three attempts', () => {
    expect(status([spell(0), spell(1, false), spell(2, false)])).toBe('NEEDS_SUPPORT');
    expect(status([spell(0, false), spell(1, false), spell(2)])).toBe('NEEDS_SUPPORT');
    expect(status([spell(0, false), spell(1), spell(2, false)])).toBe('NEEDS_SUPPORT');
  });

  it('counts any challenge type', () => {
    expect(status([choose(0, false), spell(1, false)])).toBe('NEEDS_SUPPORT');
  });

  it('flags a new word missed on both of its first two attempts', () => {
    expect(status([choose(0, false), choose(1, false)])).toBe('NEEDS_SUPPORT');
  });

  it('does not flag a single miss', () => {
    expect(status([choose(0, false)])).toBe('IN_PROGRESS');
    expect(status([spell(0, false), spell(1), spell(2)])).toBe('IN_PROGRESS');
  });

  it('only looks at the last three attempts', () => {
    expect(status([spell(0, false), spell(1, false), spell(2), spell(3), spell(4)])).toBe('IN_PROGRESS');
  });

  it('clears itself as the child improves', () => {
    const misses = [spell(0, false), spell(1, false)];
    expect(status(misses)).toBe('NEEDS_SUPPORT');
    expect(status([...misses, spell(2), spell(3)])).toBe('IN_PROGRESS');
  });

  it('never applies to a mastered word', () => {
    // Mastered by spelling, then two recognition misses: 2 of the last 3 are wrong.
    const attempts = [spell(0), spell(3), spell(7), choose(8, false), choose(9, false)];
    expect(status(attempts)).toBe('MASTERED');
  });
});
