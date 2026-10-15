import { describe, expect, it } from 'vitest';
import { isInTrial, trialRanOut, trialRefusal } from './trial-rules.js';

const NOW = new Date('2026-03-10T12:00:00Z');
const AHEAD = new Date(NOW.getTime() + 1000);
const BEHIND = new Date(NOW.getTime() - 1000);
const auto = (trialUntil: Date | null, trialConfirmedAt: Date | null = null) => ({
  joinedVia: 'auto',
  trialUntil,
  trialConfirmedAt,
});

describe('trial rules (FR-TEAM-22, -24)', () => {
  it('a member is in the trial until the end, not at the end', () => {
    expect(isInTrial(auto(AHEAD), NOW)).toBe(true);
    expect(isInTrial(auto(NOW), NOW)).toBe(false);
    expect(isInTrial(auto(BEHIND), NOW)).toBe(false);
  });

  it('a confirmed trial or a member without a trial is not in the trial', () => {
    expect(isInTrial(auto(AHEAD, BEHIND), NOW)).toBe(false);
    expect(isInTrial(auto(null), NOW)).toBe(false);
  });

  it('refuses a member who did not come from the queue before looking at the time', () => {
    const regular = { joinedVia: 'invite', trialUntil: null, trialConfirmedAt: null };
    expect(trialRefusal(regular, NOW)).toBe('NOT_AUTO_ADDED');
    expect(trialRefusal({ ...regular, trialUntil: AHEAD }, NOW)).toBe('NOT_AUTO_ADDED');
  });

  it('refuses an auto-added member after the end or after the confirmation', () => {
    expect(trialRefusal(auto(AHEAD), NOW)).toBeUndefined();
    expect(trialRefusal(auto(BEHIND), NOW)).toBe('TRIAL_EXPIRED');
    expect(trialRefusal(auto(AHEAD, BEHIND), NOW)).toBe('TRIAL_EXPIRED');
  });

  it('the timer acts only on an unconfirmed trial that has ended', () => {
    expect(trialRanOut(auto(BEHIND), NOW)).toBe(true);
    expect(trialRanOut(auto(NOW), NOW)).toBe(true);
    expect(trialRanOut(auto(AHEAD), NOW)).toBe(false);
    expect(trialRanOut(auto(BEHIND, BEHIND), NOW)).toBe(false);
    expect(trialRanOut({ ...auto(BEHIND), joinedVia: 'invite' }, NOW)).toBe(false);
  });
});
