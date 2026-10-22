import { describe, expect, it } from 'vitest';
import { ANONYMOUS_CALLER_OPERATIONS, loggedUserId } from './request-line.js';

describe('loggedUserId (FR-PROF-08, SEC-04)', () => {
  it('names the caller of an ordinary operation', () => {
    expect(loggedUserId({ operationId: 'getTeam', userId: 'u-1' })).toBe('u-1');
  });

  it('does not name the caller of the operations that write or list reviews of the caller', () => {
    for (const operationId of ANONYMOUS_CALLER_OPERATIONS) {
      expect(loggedUserId({ operationId, userId: 'u-1' }), operationId).toBeUndefined();
    }
    expect([...ANONYMOUS_CALLER_OPERATIONS].sort()).toEqual(['createPeerReview', 'listSentReviews']);
  });

  it('returns nothing when the request has no context or no user yet', () => {
    expect(loggedUserId(undefined)).toBeUndefined();
    expect(loggedUserId({ operationId: 'getTeam' })).toBeUndefined();
  });
});
