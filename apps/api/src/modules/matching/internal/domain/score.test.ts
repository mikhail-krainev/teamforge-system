import { describe, expect, it } from 'vitest';
import {
  availabilityScore,
  compareRecommendations,
  completedScore,
  DEFAULT_WEIGHTS,
  evaluatePair,
  isPairAllowed,
  levelInRole,
  levelScore,
  levelSteps,
  round3,
  stackScore,
  timezoneScore,
  utcOffsetHours,
  type CandidateFacts,
  type SeatFacts,
} from './score.js';

const WINTER = new Date('2026-01-15T12:00:00Z');
const SUMMER = new Date('2026-07-15T12:00:00Z');

const seat: SeatFacts = {
  roleCode: 'backend',
  teamId: 'team-1',
  minLevel: 'junior',
  minHours: 6,
  stack: ['typescript', 'react'],
  teamTimezone: 'Europe/Moscow',
  teamHoursPerWeek: 10,
  memberUserIds: ['lead'],
};

const person: CandidateFacts = {
  userId: 'u1',
  level: 'junior',
  hoursPerWeek: 10,
  timezone: 'Europe/Moscow',
  stack: ['typescript', 'react'],
  completedInRole: 0,
};

describe('utcOffsetHours', () => {
  it('reads the offset of a zone without daylight saving', () => {
    expect(utcOffsetHours('Europe/Moscow', WINTER)).toBe(3);
    expect(utcOffsetHours('Asia/Vladivostok', WINTER)).toBe(10);
    expect(utcOffsetHours('UTC', WINTER)).toBe(0);
  });

  it('follows daylight saving time on the given date', () => {
    expect(utcOffsetHours('Europe/Berlin', WINTER)).toBe(1);
    expect(utcOffsetHours('Europe/Berlin', SUMMER)).toBe(2);
    expect(utcOffsetHours('America/New_York', WINTER)).toBe(-5);
    expect(utcOffsetHours('America/New_York', SUMMER)).toBe(-4);
  });

  it('handles half-hour zones', () => {
    expect(utcOffsetHours('Asia/Kolkata', WINTER)).toBe(5.5);
  });

  it('is null for an unknown zone', () => {
    expect(utcOffsetHours('Nowhere/Land', WINTER)).toBeNull();
  });

  it('ignores the milliseconds of the instant', () => {
    expect(utcOffsetHours('Europe/Moscow', new Date('2026-01-15T12:00:00.789Z'))).toBe(3);
  });
});

describe('component scores', () => {
  it('levelScore: 1 at the minimum, 0.75 one step above, 0.5 two steps above, 0 below', () => {
    expect(levelScore('junior', 'junior')).toBe(1);
    expect(levelScore('middle', 'junior')).toBe(0.75);
    expect(levelScore('middle', 'beginner')).toBe(0.5);
    expect(levelScore('beginner', 'junior')).toBe(0);
  });

  it('levelSteps counts the steps between two levels', () => {
    expect(levelSteps('middle', 'beginner')).toBe(2);
    expect(levelSteps('beginner', 'middle')).toBe(-2);
  });

  it('stackScore: share of the seat stack, 1 when the seat names none', () => {
    expect(stackScore([], ['x'])).toEqual({ score: 1, matched: [] });
    expect(stackScore(['a', 'b'], ['b'])).toEqual({ score: 0.5, matched: ['b'] });
    expect(stackScore(['a', 'b'], [])).toEqual({ score: 0, matched: [] });
    expect(stackScore(['b', 'a', 'a'], ['a', 'b', 'c'])).toEqual({ score: 1, matched: ['a', 'b'] });
  });

  it('timezoneScore falls linearly to 0 at 6 hours', () => {
    expect(timezoneScore(0)).toBe(1);
    expect(timezoneScore(3)).toBe(0.5);
    expect(timezoneScore(-3)).toBe(0.5);
    expect(timezoneScore(6)).toBe(0);
    expect(timezoneScore(9)).toBe(0);
  });

  it('availabilityScore: hours over the larger of the seat minimum and the team hours, capped at 1', () => {
    expect(availabilityScore(8, 6, 10)).toBe(0.8);
    expect(availabilityScore(20, 6, 10)).toBe(1);
    expect(availabilityScore(8, 12, 10)).toBeCloseTo(8 / 12, 10);
    expect(availabilityScore(0, 0, 0)).toBe(1);
  });

  it('completedScore saturates at 3 projects', () => {
    expect(completedScore(0)).toBe(0);
    expect(completedScore(1)).toBeCloseTo(1 / 3, 10);
    expect(completedScore(3)).toBe(1);
    expect(completedScore(10)).toBe(1);
    expect(completedScore(-2)).toBe(0);
  });

  it('round3 keeps three digits', () => {
    expect(round3(0.12345)).toBe(0.123);
    expect(round3(0.9996)).toBe(1);
  });

  it('the default weights add up to 1', () => {
    const sum = Object.values(DEFAULT_WEIGHTS).reduce((a, b) => a + b, 0);
    expect(sum).toBeCloseTo(1, 10);
  });
});

describe('evaluatePair: hard filters (FR-MATCH-12)', () => {
  it('rejects a level below the seat minimum', () => {
    expect(evaluatePair(seat, { ...person, level: 'beginner' }, WINTER)).toEqual({
      eligible: false,
      reason: 'level',
    });
  });

  it('rejects fewer hours than the seat minimum', () => {
    expect(evaluatePair(seat, { ...person, hoursPerWeek: 5 }, WINTER)).toEqual({
      eligible: false,
      reason: 'hours',
    });
  });

  it('rejects a zone more than 6 hours away and keeps exactly 6', () => {
    expect(evaluatePair(seat, { ...person, timezone: 'Asia/Vladivostok' }, WINTER)).toEqual({
      eligible: false,
      reason: 'timezone',
    });
    const edge = evaluatePair(seat, { ...person, timezone: 'Asia/Tokyo' }, WINTER);
    expect(edge.eligible && edge.reasons.timezoneDiffHours).toBe(6);
  });

  it('rejects an unknown zone of the candidate or the team', () => {
    expect(evaluatePair(seat, { ...person, timezone: 'Nowhere/Land' }, WINTER)).toEqual({
      eligible: false,
      reason: 'timezone',
    });
    expect(evaluatePair({ ...seat, teamTimezone: 'Nowhere/Land' }, person, WINTER)).toEqual({
      eligible: false,
      reason: 'timezone',
    });
  });

  it('uses the offsets of the given date: Berlin vs Moscow is 2 h in winter and 1 h in summer', () => {
    const winter = evaluatePair(seat, { ...person, timezone: 'Europe/Berlin' }, WINTER);
    const summer = evaluatePair(seat, { ...person, timezone: 'Europe/Berlin' }, SUMMER);
    expect(winter.eligible && winter.reasons.timezoneDiffHours).toBe(2);
    expect(summer.eligible && summer.reasons.timezoneDiffHours).toBe(1);
  });
});

describe('evaluatePair: weighted score (C-44)', () => {
  it('a perfect candidate scores 0.9 plus the completed-projects share', () => {
    const none = evaluatePair(seat, person, WINTER);
    expect(none.eligible && none.score).toBe(0.9);
    const full = evaluatePair(seat, { ...person, completedInRole: 3 }, WINTER);
    expect(full.eligible && full.score).toBe(1);
  });

  it('is the weighted sum of the components, rounded to three digits', () => {
    const result = evaluatePair(
      { ...seat, minHours: 6, stack: ['typescript', 'react'] },
      {
        ...person,
        level: 'middle',
        hoursPerWeek: 8,
        timezone: 'Europe/Samara',
        stack: ['typescript'],
      },
      WINTER,
    );
    const expected = 0.35 * 0.5 + 0.2 * 0.75 + 0.2 * (1 - 1 / 6) + 0.15 * 0.8 + 0.1 * 0;
    expect(result.eligible && result.score).toBe(Math.round(expected * 1000) / 1000);
    if (!result.eligible) throw new Error('rejected');
    expect(result.reasons).toEqual({
      role: true,
      stack: 0.5,
      level: 0.75,
      timezone: 0.8333,
      availability: 0.8,
      completedProjects: 0,
      matchedStackTags: ['typescript'],
      timezoneDiffHours: 1,
    });
  });

  it('is deterministic', () => {
    expect(evaluatePair(seat, person, WINTER)).toEqual(evaluatePair(seat, person, WINTER));
  });

  it('uses the weights it is given', () => {
    const onlyStack = { stack: 1, level: 0, timezone: 0, availability: 0, completed: 0 };
    const result = evaluatePair(seat, { ...person, stack: ['typescript'] }, WINTER, onlyStack);
    expect(result.eligible && result.score).toBe(0.5);
  });

  it('keeps the score inside 0..1 even for weights that do not add up', () => {
    const heavy = { stack: 2, level: 2, timezone: 2, availability: 2, completed: 2 };
    const result = evaluatePair(seat, { ...person, completedInRole: 3 }, WINTER, heavy);
    expect(result.eligible && result.score).toBe(1);
  });
});

describe('isPairAllowed and ordering', () => {
  it('refuses members, the lead and teams that excluded the candidate', () => {
    const none = new Set<string>();
    expect(isPairAllowed(seat, 'someone', none)).toBe(true);
    expect(isPairAllowed(seat, 'lead', none)).toBe(false);
    expect(isPairAllowed(seat, 'someone', new Set(['team-1']))).toBe(false);
    expect(isPairAllowed(seat, 'someone', new Set(['team-2']))).toBe(true);
  });

  it('orders by score descending and then by user id', () => {
    const rows = [
      { score: 0.5, userId: 'b' },
      { score: 0.9, userId: 'z' },
      { score: 0.5, userId: 'a' },
    ];
    expect(rows.sort(compareRecommendations).map((r) => r.userId)).toEqual(['z', 'a', 'b']);
    expect(compareRecommendations({ score: 1, userId: 'a' }, { score: 1, userId: 'a' })).toBe(0);
  });

  it('levelInRole falls back to beginner for a role the profile does not list', () => {
    const prefs = [{ roleCode: 'backend', level: 'middle' as const }];
    expect(levelInRole(prefs, 'backend')).toBe('middle');
    expect(levelInRole(prefs, 'qa')).toBe('beginner');
  });
});
