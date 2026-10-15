import { Inject, Injectable } from '@nestjs/common';
import { and, desc, eq, inArray, lt, not, sql, type SQL } from 'drizzle-orm';
import { TxRunner } from '../../../../platform/tx/tx-runner.js';
import { ACTIVE_PROJECT_STATUSES, MAX_MEMBERS } from '../domain/team-rules.js';
import { membership, seat, seatAssignment, team } from '../schema/teams.js';
import type { AssignmentRow, MembershipRow, TeamRow } from './team.repository.js';

export interface CatalogFilter {
  statuses: readonly string[];
  role?: string | undefined;
  stack: readonly string[];
  productType?: string | undefined;
  tzOffsetMin?: number | undefined;
  tzOffsetMax?: number | undefined;
  /** Moment used to turn time zone names into UTC offsets (the Clock, never SQL `now()`). */
  now: Date;
}

export interface KeysetCursor {
  at: Date;
  id: string;
}

export interface OpenSeatRow {
  teamId: string;
  seatId: string;
  roleCode: string;
  minLevel: string;
  desired: boolean;
}

export interface MyMembershipRow {
  membership: MembershipRow;
  team: TeamRow;
}

/** List queries over teams: the public catalog and "my teams" (FR-TEAM-26, FR-TEAM-05). */
@Injectable()
export class TeamListRepository {
  constructor(@Inject(TxRunner) private readonly tx: TxRunner) {}

  /**
   * Teams of the catalog that still have an open seat matching the filters (FR-TEAM-26) and room
   * for a new member. Keyset `(created_at, id)` desc over `team_catalog_idx`; `limit` rows.
   */
  listCatalog(filter: CatalogFilter, after: KeysetCursor | undefined, limit: number) {
    return this.tx.tx
      .select()
      .from(team)
      .where(
        and(
          inArray(team.status, [...filter.statuses]),
          lt(team.memberCount, MAX_MEMBERS),
          filter.productType === undefined
            ? undefined
            : eq(team.productTypeCode, filter.productType),
          this.offsetRange(filter),
          this.openSeatExists(filter),
          after === undefined
            ? undefined
            : sql`(${team.createdAt}, ${team.id}) < (${after.at.toISOString()}::timestamptz, ${after.id}::uuid)`,
        ),
      )
      .orderBy(desc(team.createdAt), desc(team.id))
      .limit(limit);
  }

  /** UTC offset of the team zone in minutes at `now`, compared with the requested range. */
  private offsetRange(filter: CatalogFilter): SQL | undefined {
    if (filter.tzOffsetMin === undefined && filter.tzOffsetMax === undefined) return undefined;
    const at = filter.now.toISOString();
    const offset = sql`EXTRACT(EPOCH FROM ((${at}::timestamptz AT TIME ZONE ${team.timezone}) - (${at}::timestamptz AT TIME ZONE 'UTC'))) / 60`;
    return and(
      filter.tzOffsetMin === undefined ? undefined : sql`${offset} >= ${filter.tzOffsetMin}`,
      filter.tzOffsetMax === undefined ? undefined : sql`${offset} <= ${filter.tzOffsetMax}`,
    );
  }

  /** One open seat must satisfy the role and the stack filter together. */
  private openSeatExists(filter: CatalogFilter): SQL {
    const tags = sql.join(
      filter.stack.map((tag) => sql`${tag}`),
      sql`, `,
    );
    return sql`EXISTS (SELECT 1 FROM ${seat}
      WHERE ${seat.teamId} = ${team.id} AND ${seat.status} = 'open'
      ${filter.role === undefined ? sql`` : sql`AND ${seat.roleCode} = ${filter.role}`}
      ${filter.stack.length === 0 ? sql`` : sql`AND ${seat.stack} && ARRAY[${tags}]::text[]`})`;
  }

  /** Open seats of several teams in one query (no query per team). */
  openSeatsOf(teamIds: string[]): Promise<OpenSeatRow[]> {
    if (teamIds.length === 0) return Promise.resolve([]);
    return this.tx.tx
      .select({
        teamId: seat.teamId,
        seatId: seat.id,
        roleCode: seat.roleCode,
        minLevel: seat.minLevel,
        desired: seat.desired,
      })
      .from(seat)
      .where(and(inArray(seat.teamId, teamIds), eq(seat.status, 'open')))
      .orderBy(seat.roleCode, seat.ordinal);
  }

  /**
   * Memberships of the user with their teams, newest first. `current`: active membership in a
   * team that still counts as an active project; `past`: everything else.
   */
  async listMine(
    userId: string,
    scope: 'current' | 'past' | undefined,
    after: KeysetCursor | undefined,
    limit: number,
  ): Promise<MyMembershipRow[]> {
    const current = and(
      eq(membership.status, 'active'),
      inArray(team.status, [...ACTIVE_PROJECT_STATUSES]),
    );
    const rows = await this.tx.tx
      .select({ membership, team })
      .from(membership)
      .innerJoin(team, eq(team.id, membership.teamId))
      .where(
        and(
          eq(membership.userId, userId),
          scope === 'current' ? current : undefined,
          scope === 'past' ? not(current as SQL) : undefined,
          after === undefined
            ? undefined
            : sql`(${membership.joinedAt}, ${membership.id}) < (${after.at.toISOString()}::timestamptz, ${after.id}::uuid)`,
        ),
      )
      .orderBy(desc(membership.joinedAt), desc(membership.id))
      .limit(limit);
    return rows;
  }

  /** Role assignments of several memberships in one query. */
  assignmentsOf(membershipIds: string[]): Promise<AssignmentRow[]> {
    if (membershipIds.length === 0) return Promise.resolve([]);
    return this.tx.tx
      .select()
      .from(seatAssignment)
      .where(inArray(seatAssignment.membershipId, membershipIds));
  }
}
