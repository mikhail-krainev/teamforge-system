import { describe, expect, it } from 'vitest';
import { authorsOf, isReviewPassed, unknownOrdinals } from './review-rules.js';

describe('review rules (FR-WORK-09)', () => {
  it('passes only when every point is yes or an accepted risk', () => {
    expect(isReviewPassed([])).toBe(false);
    expect(isReviewPassed([{ answer: true, riskAccepted: false }])).toBe(true);
    expect(isReviewPassed([{ answer: false, riskAccepted: false }])).toBe(false);
    expect(isReviewPassed([{ answer: null, riskAccepted: false }])).toBe(false);
    expect(
      isReviewPassed([
        { answer: true, riskAccepted: false },
        { answer: false, riskAccepted: true },
      ]),
    ).toBe(true);
  });

  it('finds ordinals outside 1..count', () => {
    expect(unknownOrdinals(3, [1, 3, 4, 0, 99])).toEqual([4, 0, 99]);
  });

  it('collects the authors of an item', () => {
    const authors = authorsOf({ assigneeUserId: 'a', doneBy: null, fileUploaders: ['b', 'a'] });
    expect([...authors].sort()).toEqual(['a', 'b']);
  });
});
