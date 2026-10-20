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

  it('an item nobody is assigned to and nobody closed has only its uploaders as authors; one with nothing has none', () => {
    expect([...authorsOf({ assigneeUserId: null, doneBy: null, fileUploaders: ['x'] })]).toEqual([
      'x',
    ]);
    expect(authorsOf({ assigneeUserId: null, doneBy: null, fileUploaders: [] }).size).toBe(0);
  });

  it('the one who closed the item is an author even when he is not the assignee', () => {
    const authors = authorsOf({ assigneeUserId: 'a', doneBy: 'c', fileUploaders: [] });
    expect([...authors].sort()).toEqual(['a', 'c']);
  });

  it('non-integer, negative and zero ordinals do not exist; the count itself does', () => {
    expect(unknownOrdinals(2, [2.5, -1, 0, 2])).toEqual([2.5, -1, 0]);
    expect(unknownOrdinals(0, [1])).toEqual([1]);
  });

  it('a "yes" that is also marked as an accepted risk still passes; one unanswered point with a risk passes (the lead decided)', () => {
    expect(isReviewPassed([{ answer: true, riskAccepted: true }])).toBe(true);
    expect(isReviewPassed([{ answer: null, riskAccepted: true }])).toBe(true);
    expect(
      isReviewPassed([
        { answer: true, riskAccepted: false },
        { answer: null, riskAccepted: false },
      ]),
    ).toBe(false);
  });
});
