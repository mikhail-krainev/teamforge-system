import { Inject, Injectable } from '@nestjs/common';
import {
  type CursorPayload,
  type Page,
  buildPage,
  clampLimit,
  decodeCursor,
} from '../../../../platform/db/pagination.js';
import { DomainError } from '../../../../platform/errors/domain-error.js';
import { PROFILES_API, type ProfilesApi } from '../../../profiles/public.js';
import { TEAMS_API, type TeamsApi } from '../../../teams/public.js';
import {
  type MatchCandidateRow,
  RecommendRepository,
  type ScoreCursor,
} from '../repositories/recommend.repository.js';
import {
  type CandidateRecommendationDto,
  type TeamRecommendationDto,
  toCandidateDto,
  toTeamRecommendationDto,
} from './recommend-dto.js';

export interface RecommendQuery {
  cursor?: string | undefined;
  limit?: number | undefined;
  role?: string | undefined;
}

function invalidCursor(): DomainError {
  return new DomainError('VALIDATION_FAILED', 400, {
    errors: [{ pointer: '/cursor', code: 'invalid_cursor', message: 'Invalid cursor' }],
  });
}

function scoreCursor(payload: CursorPayload): ScoreCursor {
  const [score, id] = payload.k;
  if (typeof score !== 'string' || typeof id !== 'string' || !/^\d(\.\d{1,3})?$/.test(score)) {
    throw invalidCursor();
  }
  return { score, id };
}

/**
 * Reads of the precomputed `match_candidate` (FR-MATCH-01, FR-MATCH-02): never scored in the
 * request. A page costs a fixed number of statements: the rows, one batch of names, one for the
 * seat check.
 */
@Injectable()
export class RecommendService {
  constructor(
    @Inject(TEAMS_API) private readonly teams: TeamsApi,
    @Inject(PROFILES_API) private readonly profiles: ProfilesApi,
    @Inject(RecommendRepository) private readonly matches: RecommendRepository,
  ) {}

  /** `listSeatCandidates`: the lead of `teamId` (checked by the actor policy) asks about `seatId`. */
  async listSeatCandidates(
    teamId: string,
    seatId: string,
    query: RecommendQuery,
  ): Promise<Page<CandidateRecommendationDto>> {
    const filters = { seatId };
    const limit = clampLimit(query.limit);
    const after = this.after(query.cursor, filters);
    // A seat of another team looks like a missing one (architecture 13.14).
    if (!(await this.teams.seatBelongsToTeam(teamId, seatId))) {
      throw new DomainError('NOT_FOUND', 404);
    }
    const rows = await this.matches.listForSeat(seatId, after, limit + 1);
    const page = this.page(rows, limit, (row) => row.userId, filters);
    const names = await this.profiles.getDisplayNames(page.items.map((row) => row.userId));
    return {
      items: page.items.map((row) => toCandidateDto(row, names.get(row.userId) ?? '')),
      nextCursor: page.nextCursor,
    };
  }

  /** `listRecommendedTeams`: the open seats that suit the signed-in user. */
  async listRecommendedTeams(
    userId: string,
    query: RecommendQuery,
  ): Promise<Page<TeamRecommendationDto>> {
    const filters = { userId, role: query.role ?? null };
    const limit = clampLimit(query.limit);
    const after = this.after(query.cursor, filters);
    const rows = await this.matches.listForUser(userId, query.role, after, limit + 1);
    const page = this.page(rows, limit, (row) => row.seatId, filters);
    const names = await this.teams.getTeamNames([...new Set(page.items.map((row) => row.teamId))]);
    return {
      items: page.items.map((row) => toTeamRecommendationDto(row, names.get(row.teamId) ?? '')),
      nextCursor: page.nextCursor,
    };
  }

  private after(cursor: string | undefined, filters: Record<string, unknown>) {
    return cursor === undefined ? undefined : scoreCursor(decodeCursor(cursor, filters));
  }

  private page(
    rows: MatchCandidateRow[],
    limit: number,
    idOf: (row: MatchCandidateRow) => string,
    filters: Record<string, unknown>,
  ): Page<MatchCandidateRow> {
    return buildPage(rows, limit, (row) => [row.score, idOf(row)], filters);
  }
}
