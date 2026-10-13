import { describe, expect, it } from 'vitest';
import { sampleVote } from './fixtures';
import { formatRemaining, isVotable, pickVote } from './model';

const MIN = 60_000;
const HOUR = 60 * MIN;

describe('formatRemaining', () => {
  it('formats days, hours and minutes in Russian', () => {
    expect(formatRemaining(2 * 24 * HOUR + 3 * HOUR + 10 * MIN)).toBe('2 д 3 ч');
    expect(formatRemaining(5 * HOUR + 12 * MIN)).toBe('5 ч 12 мин');
    expect(formatRemaining(7 * MIN + 20_000)).toBe('7 мин');
    expect(formatRemaining(5_000)).toBe('1 мин');
  });

  it('is null once the deadline has passed', () => {
    expect(formatRemaining(0)).toBeNull();
    expect(formatRemaining(-1)).toBeNull();
  });
});

describe('pickVote', () => {
  it('prefers the vote in progress over a newer closed one', () => {
    const closed = sampleVote({ id: 'a', status: 'closed' });
    const active = sampleVote({ id: 'b', status: 'voting' });
    expect(pickVote([closed, active])?.id).toBe('b');
    expect(pickVote([closed])?.id).toBe('a');
    expect(pickVote([])).toBeUndefined();
  });
});

describe('isVotable', () => {
  it('needs consent and no withdrawal', () => {
    expect(isVotable({ userId: 'u', confirmed: true, withdrawn: false })).toBe(true);
    expect(isVotable({ userId: 'u', confirmed: false, withdrawn: false })).toBe(false);
    expect(isVotable({ userId: 'u', confirmed: true, withdrawn: true })).toBe(false);
  });
});
