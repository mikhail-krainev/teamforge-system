import { describe, expect, it } from 'vitest';
import {
  AUTO_ADD_WINDOW_MS,
  compareApplications,
  matchPossibleAt,
  orderPairs,
  type AutoAddPair,
  windowOf,
} from './auto-add-rules.js';

const T0 = Date.parse('2026-10-16T10:00:00Z');
const at = (offsetMs: number): Date => new Date(T0 + offsetMs);

function pair(over: Partial<AutoAddPair> & { seatId: string }): AutoAddPair {
  return {
    teamId: 't',
    roleCode: 'backend',
    priority: 1,
    score: 0.8,
    openedAt: at(0),
    addedAt: at(0),
    ...over,
  };
}

describe('windowOf', () => {
  it('numbers the 60 second windows (C-38)', () => {
    expect(AUTO_ADD_WINDOW_MS).toBe(60_000);
    expect(windowOf(new Date(0))).toBe(0);
    expect(windowOf(new Date(59_999))).toBe(0);
    expect(windowOf(new Date(60_000))).toBe(1);
  });
});

describe('matchPossibleAt (FR-MATCH-06)', () => {
  it('is the later of the seat opening and the role being added to the application', () => {
    expect(matchPossibleAt(at(5), at(9))).toEqual(at(9));
    expect(matchPossibleAt(at(9), at(5))).toEqual(at(9));
  });

  it('a seat that never recorded an opening counts from the moment of the role', () => {
    expect(matchPossibleAt(null, at(5))).toEqual(at(5));
  });
});

describe('orderPairs (architecture 6.4 step 2)', () => {
  it('the same window: the smaller priority number comes first', () => {
    const ordered = orderPairs([
      pair({ seatId: 'b', priority: 2 }),
      pair({ seatId: 'a', priority: 1 }),
    ]);
    expect(ordered.map((p) => p.seatId)).toEqual(['a', 'b']);
  });

  it('the same window and priority: the higher score first, then the older seat, then the seat id', () => {
    const ordered = orderPairs([
      pair({ seatId: 'z', score: 0.6 }),
      pair({ seatId: 'y', score: 0.9, openedAt: at(10) }),
      pair({ seatId: 'x', score: 0.9, openedAt: at(5) }),
      pair({ seatId: 'w', score: 0.9, openedAt: at(5) }),
    ]);
    expect(ordered.map((p) => p.seatId)).toEqual(['w', 'x', 'y', 'z']);
  });

  it('an earlier window beats a higher priority', () => {
    const ordered = orderPairs([
      pair({ seatId: 'late-high', priority: 1, openedAt: at(5 * 60_000) }),
      pair({ seatId: 'early-low', priority: 2 }),
    ]);
    expect(ordered.map((p) => p.seatId)).toEqual(['early-low', 'late-high']);
  });

  it('a role added to the application later moves its pairs to a later window', () => {
    const ordered = orderPairs([
      pair({ seatId: 'new-role', priority: 1, addedAt: at(3 * 60_000) }),
      pair({ seatId: 'old-role', priority: 2 }),
    ]);
    expect(ordered.map((p) => p.seatId)).toEqual(['old-role', 'new-role']);
  });

  it('a seat without a recorded opening is tried from the moment of the role, by its own key', () => {
    const ordered = orderPairs([
      pair({ seatId: 'known', openedAt: at(20_000), addedAt: at(0) }),
      pair({ seatId: 'unknown', openedAt: null, addedAt: at(10_000) }),
    ]);
    // both fall into the first window; the unknown opening counts as the role moment (10 s) < 20 s
    expect(ordered.map((p) => p.seatId)).toEqual(['unknown', 'known']);
  });

  it('a lower priority number and a higher score each decide before the seat age', () => {
    const ordered = orderPairs([
      pair({ seatId: 'old', priority: 2, score: 0.99, openedAt: at(0) }),
      pair({ seatId: 'young', priority: 1, score: 0.5, openedAt: at(30_000) }),
    ]);
    expect(ordered.map((p) => p.seatId)).toEqual(['young', 'old']);
  });

  it('pairs of the same seat keep their input order (nothing to break the tie)', () => {
    const first = pair({ seatId: 'same', roleCode: 'backend' });
    const second = pair({ seatId: 'same', roleCode: 'frontend' });
    expect(orderPairs([first, second])).toEqual([first, second]);
    expect(orderPairs([second, first])).toEqual([second, first]);
  });

  it('equal keys: the seat id decides, whatever the input order', () => {
    const a = pair({ seatId: 'a' });
    const b = pair({ seatId: 'b' });
    expect(orderPairs([a, b])).toEqual([a, b]);
    expect(orderPairs([b, a])).toEqual([a, b]);
  });

  it('does not change its input', () => {
    const input = [pair({ seatId: 'b', priority: 2 }), pair({ seatId: 'a', priority: 1 })];
    orderPairs(input);
    expect(input.map((p) => p.seatId)).toEqual(['b', 'a']);
  });
});

describe('compareApplications (fairness)', () => {
  it('the one who waits longer first, then the id', () => {
    const list = [
      { id: 'b', enqueuedAt: at(0) },
      { id: 'c', enqueuedAt: at(-10) },
      { id: 'a', enqueuedAt: at(0) },
    ].sort(compareApplications);
    expect(list.map((a) => a.id)).toEqual(['c', 'a', 'b']);
  });

  it('is symmetric and says equal for the same wait and the same id', () => {
    const one = { id: 'a', enqueuedAt: at(0) };
    expect(compareApplications(one, { ...one })).toBe(0);
    expect(
      compareApplications({ id: 'a', enqueuedAt: at(0) }, { id: 'b', enqueuedAt: at(0) }),
    ).toBe(-1);
    expect(
      compareApplications({ id: 'b', enqueuedAt: at(0) }, { id: 'a', enqueuedAt: at(0) }),
    ).toBe(1);
  });
});
