import { describe, expect, it } from 'vitest';
import {
  buildRoleDemand,
  isDeficit,
  uniqueRoles,
  waitView,
  WAIT_MIN_SAMPLES,
} from './demand-rules.js';

describe('isDeficit (FR-MATCH-11)', () => {
  it('is true only when open seats are strictly more than the queue', () => {
    expect(isDeficit(3, 1)).toBe(true);
    expect(isDeficit(1, 0)).toBe(true);
    expect(isDeficit(2, 2)).toBe(false);
    expect(isDeficit(1, 2)).toBe(false);
    expect(isDeficit(0, 0)).toBe(false);
  });
});

describe('waitView (C-42)', () => {
  it('gives no number below the minimum number of observations', () => {
    expect(waitView(undefined)).toEqual({
      avgWaitSeconds: null,
      avgWaitStatus: 'insufficient_data',
    });
    expect(waitView({ samples: WAIT_MIN_SAMPLES - 1, avgSeconds: 100 })).toEqual({
      avgWaitSeconds: null,
      avgWaitStatus: 'insufficient_data',
    });
  });

  it('rounds the average to whole seconds from the minimum onwards', () => {
    expect(waitView({ samples: WAIT_MIN_SAMPLES, avgSeconds: 180.4 })).toEqual({
      avgWaitSeconds: 180,
      avgWaitStatus: 'ok',
    });
  });
});

describe('buildRoleDemand', () => {
  it('assembles the showcase row', () => {
    const at = new Date('2026-01-01T00:00:00Z');
    expect(
      buildRoleDemand('qa', { openSeats: 3, teamsSeeking: 2, queued: 1, wait: undefined }, at),
    ).toEqual({
      roleCode: 'qa',
      teamsSeeking: 2,
      openSeats: 3,
      queuedCandidates: 1,
      avgWaitSeconds: null,
      avgWaitStatus: 'insufficient_data',
      deficit: true,
      computedAt: at,
    });
  });
});

describe('uniqueRoles', () => {
  it('drops repeats and keeps the order', () => {
    expect(uniqueRoles(['b', 'a', 'b'])).toEqual(['b', 'a']);
  });
});
