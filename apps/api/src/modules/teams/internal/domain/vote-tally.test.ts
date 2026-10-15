import { describe, expect, it } from 'vitest';
import {
  bySeniority,
  confirmationOrder,
  leadersOf,
  majorityHolder,
  resolveTie,
  type CandidateScore,
} from './vote-tally.js';

const at = (day: number) => new Date(Date.UTC(2026, 0, day));
const score = (
  userId: string,
  votes: number,
  day = 1,
  inRunoff = false,
  seniorityKey = '',
): CandidateScore => ({ userId, votes, joinedAt: at(day), inRunoff, seniorityKey });

describe('vote tally rules', () => {
  it('leadersOf: all candidates with the top count, none for an empty ballot', () => {
    expect(leadersOf([])).toEqual([]);
    expect(leadersOf([score('a', 1), score('b', 2), score('c', 2)]).map((s) => s.userId)).toEqual([
      'b',
      'c',
    ]);
    expect(leadersOf([score('a', 0), score('b', 0)])).toHaveLength(2);
  });

  it('majorityHolder: strictly more than half of the eligible snapshot', () => {
    expect(majorityHolder([score('a', 2)], 4)).toBeUndefined();
    expect(majorityHolder([score('a', 3)], 4)?.userId).toBe('a');
    expect(majorityHolder([score('a', 2)], 3)?.userId).toBe('a');
  });

  it('confirmationOrder: votes, then seniority; after a runoff its candidates go first', () => {
    const scores = [score('a', 1, 3), score('b', 3, 5), score('c', 3, 2), score('d', 0, 1, true)];
    expect(confirmationOrder(scores, 1).map((s) => s.userId)).toEqual(['c', 'b', 'a', 'd']);
    expect(confirmationOrder(scores, 2).map((s) => s.userId)).toEqual(['d', 'c', 'b', 'a']);
  });

  it('bySeniority: earlier joined first, the id breaks an exact tie', () => {
    expect(bySeniority(score('a', 0, 2), score('b', 0, 1))).toBeGreaterThan(0);
    expect(bySeniority(score('a', 0, 1), score('b', 0, 1))).toBeLessThan(0);
  });

  it('resolveTie: the longer-serving member wins without a draw', () => {
    const result = resolveTie([score('a', 2, 4), score('b', 2, 2)], () => {
      throw new Error('no draw expected');
    });
    expect(result).toMatchObject({ byLot: false, winner: { userId: 'b' } });
  });

  it('resolveTie: the same moment of joining is ordered by the membership, no draw', () => {
    const result = resolveTie(
      [score('a', 2, 2, false, 'm2'), score('b', 2, 2, false, 'm1')],
      () => {
        throw new Error('no draw expected');
      },
    );
    expect(result).toMatchObject({ byLot: false, winner: { userId: 'b' } });
  });

  it('resolveTie: when nothing separates the members the draw is among the equals only', () => {
    const tied = [score('a', 2, 2), score('b', 2, 2), score('c', 2, 5)];
    const draws: number[] = [];
    const result = resolveTie(tied, (n) => {
      draws.push(n);
      return 1;
    });
    expect(draws).toEqual([2]);
    expect(result).toMatchObject({ byLot: true, winner: { userId: 'b' } });
  });

  it('resolveTie: refuses an empty list', () => {
    expect(() => resolveTie([], () => 0)).toThrow();
  });
});
