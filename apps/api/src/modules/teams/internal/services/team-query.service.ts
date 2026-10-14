import { Inject, Injectable } from '@nestjs/common';
import type { Schema } from 'shared';
import { Clock } from '../../../../platform/clock/clock.js';
import {
  type CursorPayload,
  type Page,
  buildPage,
  clampLimit,
  decodeCursor,
} from '../../../../platform/db/pagination.js';
import { DomainError } from '../../../../platform/errors/domain-error.js';
import { CATALOG_STATUSES } from '../domain/team-rules.js';
import {
  type KeysetCursor,
  type OpenSeatRow,
  TeamListRepository,
} from '../repositories/team-list.repository.js';
import { TeamEventRepository } from '../repositories/team-event.repository.js';
import { TeamRepository, type TeamRow } from '../repositories/team.repository.js';
import type { TeamDto, TeamEventDto, TeamSummaryDto } from './team-dto.js';
import type { TeamEventRow } from '../repositories/team-event.repository.js';
import { TeamViewService } from './team-view.service.js';

export interface CatalogQuery {
  cursor?: string | undefined;
  limit?: number | undefined;
  role?: string | undefined;
  /** The contract allows repeating the parameter; a single value arrives as a string. */
  stack?: string | string[] | undefined;
  productType?: string | undefined;
  tzOffsetMin?: number | undefined;
  tzOffsetMax?: number | undefined;
  status?: 'forming' | 'active' | undefined;
}

export interface MyTeamsQuery {
  cursor?: string | undefined;
  limit?: number | undefined;
  status?: 'current' | 'past' | undefined;
}

export interface EventsQuery {
  cursor?: string | undefined;
  limit?: number | undefined;
}

type MyTeamDto = Schema<'MyTeam'>;

/** Keyset position of a cursor made of `[timestamp, id]`. */
function keysetOf(payload: CursorPayload): KeysetCursor {
  const [at, id] = payload.k;
  const when = typeof at === 'string' ? new Date(at) : undefined;
  if (when === undefined || Number.isNaN(when.getTime()) || typeof id !== 'string') {
    throw new DomainError('VALIDATION_FAILED', 400, {
      errors: [{ pointer: '/cursor', code: 'invalid_cursor', message: 'Invalid cursor' }],
    });
  }
  return { at: when, id };
}

function summaryOf(row: TeamRow, openSeats: OpenSeatRow[]): TeamSummaryDto {
  return {
    id: row.id,
    name: row.name,
    productTypeCode: row.productTypeCode,
    status: row.status as TeamSummaryDto['status'],
    timezone: row.timezone,
    hoursPerWeek: row.hoursPerWeek,
    memberCount: row.memberCount,
    openSeats: openSeats.map((seat) => ({
      seatId: seat.seatId,
      roleCode: seat.roleCode,
      minLevel: seat.minLevel as TeamSummaryDto['openSeats'][number]['minLevel'],
      desired: seat.desired,
    })),
  };
}

/** Read scenarios of the teams module: getTeam, listTeams, listMyTeams, listTeamEvents. */
@Injectable()
export class TeamQueryService {
  constructor(
    @Inject(Clock) private readonly clock: Clock,
    @Inject(TeamListRepository) private readonly lists: TeamListRepository,
    @Inject(TeamEventRepository) private readonly events: TeamEventRepository,
    @Inject(TeamRepository) private readonly teams: TeamRepository,
    @Inject(TeamViewService) private readonly view: TeamViewService,
  ) {}

  get(teamId: string, viewerId: string): Promise<TeamDto> {
    return this.view.team(teamId, viewerId);
  }

  /** FR-TEAM-26: the catalog; teams without a matching open seat or without room are hidden. */
  async list(query: CatalogQuery): Promise<Page<TeamSummaryDto>> {
    const stack = query.stack === undefined ? [] : [query.stack].flat();
    const filters = {
      role: query.role ?? null,
      stack,
      productType: query.productType ?? null,
      tzOffsetMin: query.tzOffsetMin ?? null,
      tzOffsetMax: query.tzOffsetMax ?? null,
      status: query.status ?? null,
    };
    const limit = clampLimit(query.limit);
    const after =
      query.cursor === undefined ? undefined : keysetOf(decodeCursor(query.cursor, filters));
    const rows = await this.lists.listCatalog(
      {
        statuses: query.status === undefined ? CATALOG_STATUSES : [query.status],
        role: query.role,
        stack,
        productType: query.productType,
        tzOffsetMin: query.tzOffsetMin,
        tzOffsetMax: query.tzOffsetMax,
        now: this.clock.now(),
      },
      after,
      limit + 1,
    );
    const page = buildPage(rows, limit, (row) => [row.createdAt.toISOString(), row.id], filters);
    const seats = await this.lists.openSeatsOf(page.items.map((row) => row.id));
    return {
      items: page.items.map((row) =>
        summaryOf(
          row,
          seats.filter((seat) => seat.teamId === row.id),
        ),
      ),
      nextCursor: page.nextCursor,
    };
  }

  /** FR-TEAM-05: teams of the caller, current (counting against C-10) or past. */
  async listMine(userId: string, query: MyTeamsQuery): Promise<Page<MyTeamDto>> {
    const filters = { status: query.status ?? null };
    const limit = clampLimit(query.limit);
    const after =
      query.cursor === undefined ? undefined : keysetOf(decodeCursor(query.cursor, filters));
    const rows = await this.lists.listMine(userId, query.status, after, limit + 1);
    const page = buildPage(
      rows,
      limit,
      (row) => [row.membership.joinedAt.toISOString(), row.membership.id],
      filters,
    );
    const [seats, assignments] = await Promise.all([
      this.lists.openSeatsOf(page.items.map((row) => row.team.id)),
      this.lists.assignmentsOf(page.items.map((row) => row.membership.id)),
    ]);
    return {
      items: page.items.map(({ membership, team }) => ({
        team: summaryOf(
          team,
          seats.filter((seat) => seat.teamId === team.id),
        ),
        myRoles: [
          ...new Set(
            assignments
              .filter(
                (a) =>
                  a.membershipId === membership.id &&
                  (membership.status !== 'active' || a.endedAt === null),
              )
              .map((a) => a.roleCode),
          ),
        ],
        isLead: team.leadUserId === userId,
        membershipStatus: membership.status as MyTeamDto['membershipStatus'],
      })),
      nextCursor: page.nextCursor,
    };
  }

  /**
   * FR-TEAM-03, FR-TEAM-21: the journal of the team, newest first. The offers are visible to the
   * lead only (listSeatOffers), so members do not see the candidate in `offer_created` (S3SEC-05).
   */
  async listEvents(
    teamId: string,
    viewerId: string,
    query: EventsQuery,
  ): Promise<Page<TeamEventDto>> {
    const isLead = (await this.teams.find(teamId))?.leadUserId === viewerId;
    const limit = clampLimit(query.limit);
    const after =
      query.cursor === undefined ? undefined : keysetOf(decodeCursor(query.cursor, { teamId }));
    const rows = await this.events.list(teamId, after, limit + 1);
    const page = buildPage(rows, limit, (row) => [row.at.toISOString(), row.id], { teamId });
    return {
      items: page.items.map((row) => eventDto(isLead ? row : withoutCandidate(row))),
      nextCursor: page.nextCursor,
    };
  }
}

function eventDto(row: TeamEventRow): TeamEventDto {
  return {
    id: row.id,
    type: row.type,
    actorUserId: row.actorUserId,
    payload: row.payload as TeamEventDto['payload'],
    at: row.at.toISOString(),
  };
}

/** `offer_created` without the candidate: not in the payload, and not as the actor of a join request. */
function withoutCandidate(row: TeamEventRow): TeamEventRow {
  if (row.type !== 'offer_created') return row;
  const { userId, ...payload } = row.payload as Record<string, unknown>;
  const byCandidate = payload['direction'] === 'user_to_lead';
  return {
    ...row,
    payload,
    actorUserId: byCandidate || row.actorUserId === userId ? null : row.actorUserId,
  };
}
