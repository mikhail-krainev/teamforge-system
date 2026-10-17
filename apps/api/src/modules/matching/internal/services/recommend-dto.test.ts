import { describe, expect, it } from 'vitest';
import { completedCounters } from '../jobs/candidate-stats.consumer.js';
import type { MatchCandidateRow } from '../repositories/recommend.repository.js';
import { toCandidateDto, toReasonsDto, toTeamRecommendationDto } from './recommend-dto.js';

const row: MatchCandidateRow = {
  seatId: 'seat',
  userId: 'user',
  teamId: 'team',
  roleCode: 'backend',
  score: '0.725',
  reasons: {
    role: true,
    stack: 0.5,
    level: 1,
    timezone: 0.8333,
    availability: 1,
    completedProjects: 0,
    matchedStackTags: ['typescript', 7],
    timezoneDiffHours: 1,
    email: 'secret@example.test',
  },
  inQueue: true,
  computedAt: new Date('2026-01-15T12:00:00Z'),
};

describe('recommendation DTOs (SEC-11)', () => {
  it('toReasonsDto keeps only the contract keys', () => {
    const dto = toReasonsDto(row.reasons);
    expect(Object.keys(dto).sort()).toEqual(
      [
        'availability',
        'completedProjects',
        'level',
        'matchedStackTags',
        'role',
        'stack',
        'timezone',
        'timezoneDiffHours',
      ].sort(),
    );
    expect(dto.matchedStackTags).toEqual(['typescript']);
  });

  it('toReasonsDto survives an empty or foreign JSON and omits the optional diff', () => {
    expect(toReasonsDto(null)).toEqual({
      role: false,
      stack: 0,
      level: 0,
      timezone: 0,
      availability: 0,
      completedProjects: 0,
      matchedStackTags: [],
    });
    expect(toReasonsDto({ matchedStackTags: 'x' }).matchedStackTags).toEqual([]);
  });

  it('a candidate carries the display name and no other profile field', () => {
    const dto = toCandidateDto(row, 'Ann');
    expect(Object.keys(dto).sort()).toEqual(
      ['computedAt', 'displayName', 'inQueue', 'reasons', 'score', 'userId'].sort(),
    );
    expect(dto).toMatchObject({ score: 0.725, displayName: 'Ann', inQueue: true });
    expect(dto.computedAt).toBe('2026-01-15T12:00:00.000Z');
  });

  it('a candidate shown to a lead carries coarse time zone and availability, not the exact values', () => {
    const dto = toCandidateDto(
      {
        ...row,
        reasons: { ...(row.reasons as object), timezone: 0.7083, availability: 0.8, timezoneDiffHours: 1.75 },
      },
      'Ann',
    );
    expect(dto.reasons.timezone).toBe(0.75);
    expect(dto.reasons.availability).toBe(0.75);
    expect(dto.reasons.timezoneDiffHours).toBe(2);
    // the scores that are not derived from the person's private facts stay as they are
    expect(dto.reasons).toMatchObject({ stack: 0.5, level: 1, completedProjects: 0 });
  });

  it('a team recommendation names the team, never its lead or members', () => {
    const dto = toTeamRecommendationDto(row, 'Rockets');
    expect(Object.keys(dto).sort()).toEqual(
      ['computedAt', 'reasons', 'roleCode', 'score', 'seatId', 'teamId', 'teamName'].sort(),
    );
    // the person sees his own match with the team exactly
    expect(dto.reasons.timezone).toBe(0.8333);
    expect(dto.reasons.timezoneDiffHours).toBe(1);
  });
});

describe('completedCounters', () => {
  it('reads non-negative integer counters per role and ignores the rest', () => {
    const counters = completedCounters({ backend: 2, qa: 0, pm: -1, ux: 1.5, ops: 'x' });
    expect([...counters]).toEqual([
      ['backend', 2],
      ['qa', 0],
    ]);
  });

  it('is empty for a missing or malformed value', () => {
    expect(completedCounters(undefined).size).toBe(0);
    expect(completedCounters(null).size).toBe(0);
    expect(completedCounters([1, 2]).size).toBe(0);
    expect(completedCounters('x').size).toBe(0);
  });
});
