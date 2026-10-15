import type { Schema } from 'shared';
import type { MatchCandidateRow } from '../repositories/recommend.repository.js';

export type MatchReasonsDto = Schema<'MatchReasons'>;
export type CandidateRecommendationDto = Schema<'CandidateRecommendation'>;
export type TeamRecommendationDto = Schema<'TeamRecommendation'>;

function number(value: unknown): number {
  return typeof value === 'number' ? value : 0;
}

/** Quarter steps: a lead learns the rough fit of a candidate, not his hours or his time zone. */
const COARSE_STEP = 0.25;
const coarse = (value: number): number => Math.round(value / COARSE_STEP) * COARSE_STEP;

/**
 * The reasons exactly as the contract has them: only the listed keys leave the module, whatever
 * the stored JSON holds. `coarse` blurs the figures derived from private facts of a candidate (hours
 * per week, time zone): quarter steps and a whole number of hours.
 */
export function toReasonsDto(stored: unknown, options: { coarse?: boolean } = {}): MatchReasonsDto {
  const reasons = (stored ?? {}) as Record<string, unknown>;
  const tags = Array.isArray(reasons['matchedStackTags']) ? reasons['matchedStackTags'] : [];
  const dto: MatchReasonsDto = {
    role: reasons['role'] === true,
    stack: number(reasons['stack']),
    level: number(reasons['level']),
    timezone: number(reasons['timezone']),
    availability: number(reasons['availability']),
    completedProjects: number(reasons['completedProjects']),
    matchedStackTags: tags.filter((tag): tag is string => typeof tag === 'string'),
  };
  if (typeof reasons['timezoneDiffHours'] === 'number') {
    dto.timezoneDiffHours = reasons['timezoneDiffHours'];
  }
  if (options.coarse === true) {
    dto.timezone = coarse(dto.timezone);
    dto.availability = coarse(dto.availability);
    if (dto.timezoneDiffHours !== undefined) dto.timezoneDiffHours = Math.round(dto.timezoneDiffHours);
  }
  return dto;
}

/**
 * A candidate for a seat, as the lead sees him: the name is the display name only (SEC-11), nothing
 * else of the profile, and the reasons are coarse.
 */
export function toCandidateDto(
  row: MatchCandidateRow,
  displayName: string,
): CandidateRecommendationDto {
  return {
    userId: row.userId,
    displayName,
    score: Number(row.score),
    reasons: toReasonsDto(row.reasons, { coarse: true }),
    inQueue: row.inQueue,
    computedAt: row.computedAt.toISOString(),
  };
}

/** A team with an open seat for the viewer: no lead and no members (SEC-11). */
export function toTeamRecommendationDto(
  row: MatchCandidateRow,
  teamName: string,
): TeamRecommendationDto {
  return {
    teamId: row.teamId,
    teamName,
    seatId: row.seatId,
    roleCode: row.roleCode,
    score: Number(row.score),
    reasons: toReasonsDto(row.reasons),
    computedAt: row.computedAt.toISOString(),
  };
}
