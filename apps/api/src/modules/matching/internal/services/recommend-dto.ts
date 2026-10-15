import type { Schema } from 'shared';
import type { MatchCandidateRow } from '../repositories/recommend.repository.js';

export type MatchReasonsDto = Schema<'MatchReasons'>;
export type CandidateRecommendationDto = Schema<'CandidateRecommendation'>;
export type TeamRecommendationDto = Schema<'TeamRecommendation'>;

function number(value: unknown): number {
  return typeof value === 'number' ? value : 0;
}

/**
 * The reasons exactly as the contract has them: only the listed keys leave the module, whatever
 * the stored JSON holds.
 */
export function toReasonsDto(stored: unknown): MatchReasonsDto {
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
  return dto;
}

/** A candidate for a seat: the name is the display name only (SEC-11), nothing else of the profile. */
export function toCandidateDto(
  row: MatchCandidateRow,
  displayName: string,
): CandidateRecommendationDto {
  return {
    userId: row.userId,
    displayName,
    score: Number(row.score),
    reasons: toReasonsDto(row.reasons),
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
