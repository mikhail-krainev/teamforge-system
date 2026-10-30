import { Inject, Injectable } from '@nestjs/common';
import { and, asc, eq, gt, inArray, isNull, lt, sql, type SQL } from 'drizzle-orm';
import { Clock } from '../../../../platform/clock/clock.js';
import { DomainError, InvariantError } from '../../../../platform/errors/domain-error.js';
import { LockService } from '../../../../platform/tx/locks.js';
import { TxRunner } from '../../../../platform/tx/tx-runner.js';
import type {
  JoinSeatInput,
  JoinSeatResult,
  Level,
  OpenSeatCount,
  OpenSeatQuery,
  OpenSeatView,
  RosterMember,
  RosterSnapshot,
  TeamBrief,
  TeamId,
  TeamLockView,
  TeamStatus,
  RoleCode,
  SeatId,
  TeamsApi,
  UserId,
} from '../../public.js';
import { canonicalReleaseUrl } from '../domain/release-url.js';
import { extendedPlannedEnd } from '../domain/team-status.js';
import { membership, seat, seatAssignment, team } from '../schema/teams.js';
import { JoinService } from './join.service.js';

type TeamRow = typeof team.$inferSelect;

function toView(row: TeamRow, now: Date): TeamLockView {
  return {
    teamId: row.id,
    status: row.status as TeamStatus,
    leadUserId: row.leadUserId,
    memberCount: row.memberCount,
    startedAt: row.startedAt,
    plannedEndAt: extendedPlannedEnd(row, now),
    suspendedAt: row.suspendedAt,
    suspendedTotalSeconds: row.suspendedTotalSeconds,
    playbookId: row.playbookId,
    productType: row.productTypeCode,
    name: row.name,
    releaseUrl: row.releaseUrl,
    releaseKey: row.releaseKey,
  };
}

/** Facade of the teams module (`TeamsApi`); `joinSeat` is the join service (S3-04). */
@Injectable()
export class TeamsFacade implements TeamsApi {
  constructor(
    @Inject(TxRunner) private readonly tx: TxRunner,
    @Inject(Clock) private readonly clock: Clock,
    @Inject(LockService) private readonly locks: LockService,
    @Inject(JoinService) private readonly joins: JoinService,
  ) {}

  async getTeamView(teamId: TeamId): Promise<TeamLockView | null> {
    const rows = await this.tx.tx.select().from(team).where(eq(team.id, teamId));
    return rows[0] === undefined ? null : toView(rows[0], this.clock.now());
  }

  async getRoster(teamId: TeamId): Promise<RosterMember[]> {
    const db = this.tx.tx;
    const [teamRows, members, assignments] = await Promise.all([
      db.select({ leadUserId: team.leadUserId }).from(team).where(eq(team.id, teamId)),
      db
        .select()
        .from(membership)
        .where(and(eq(membership.teamId, teamId), eq(membership.status, 'active')))
        .orderBy(asc(membership.joinedAt), asc(membership.id)),
      db
        .select()
        .from(seatAssignment)
        .where(and(eq(seatAssignment.teamId, teamId), isNull(seatAssignment.endedAt)))
        .orderBy(asc(seatAssignment.startedAt), asc(seatAssignment.id)),
    ]);
    const leadUserId = teamRows[0]?.leadUserId ?? null;
    return members.map((m) => ({
      userId: m.userId,
      joinedAt: m.joinedAt,
      joinedVia: m.joinedVia,
      trialUntil: m.trialUntil,
      isLead: m.userId === leadUserId,
      roles: assignments
        .filter((a) => a.membershipId === m.id)
        .map((a) => ({
          roleCode: a.roleCode,
          assignedAt: a.startedAt,
          deficitAtJoin: a.deficitAtJoin,
        })),
    }));
  }

  async assertMember(teamId: TeamId, userId: UserId): Promise<void> {
    const rows = await this.tx.tx
      .select({ id: membership.id })
      .from(membership)
      .where(
        and(
          eq(membership.teamId, teamId),
          eq(membership.userId, userId),
          eq(membership.status, 'active'),
        ),
      )
      .limit(1);
    if (rows.length === 0) throw new DomainError('NOT_TEAM_MEMBER', 403);
  }

  async assertLead(teamId: TeamId, userId: UserId): Promise<void> {
    const rows = await this.tx.tx
      .select({ leadUserId: team.leadUserId })
      .from(team)
      .where(eq(team.id, teamId));
    if (rows[0]?.leadUserId !== userId) throw new DomainError('NOT_TEAM_LEAD', 403);
  }

  joinSeat(input: JoinSeatInput): Promise<JoinSeatResult> {
    return this.joins.join(input);
  }

  async countOpenSeatsByRole(roles: RoleCode[]): Promise<OpenSeatCount[]> {
    if (roles.length === 0) return [];
    const rows = await this.tx.tx
      .select({
        roleCode: seat.roleCode,
        openSeats: sql<number>`count(*)::int`,
        teamsSeeking: sql<number>`count(distinct ${seat.teamId})::int`,
      })
      .from(seat)
      .innerJoin(team, eq(team.id, seat.teamId))
      .where(
        and(
          eq(seat.status, 'open'),
          inArray(seat.roleCode, roles),
          inArray(team.status, ['forming', 'active']),
          lt(team.memberCount, 8),
        ),
      )
      .groupBy(seat.roleCode);
    return rows;
  }

  async listOpenSeats(query: OpenSeatQuery): Promise<OpenSeatView[]> {
    if (query.seatIds?.length === 0 || query.roleCodes?.length === 0) return [];
    const conditions: (SQL | undefined)[] = [
      eq(seat.status, 'open'),
      inArray(team.status, ['forming', 'active']),
      lt(team.memberCount, 8),
      query.seatIds === undefined ? undefined : inArray(seat.id, query.seatIds),
      query.roleCodes === undefined ? undefined : inArray(seat.roleCode, query.roleCodes),
      query.teamId === undefined ? undefined : eq(seat.teamId, query.teamId),
      query.afterSeatId === undefined ? undefined : gt(seat.id, query.afterSeatId),
    ];
    const db = this.tx.tx;
    const rows = await db
      .select({
        seatId: seat.id,
        teamId: seat.teamId,
        teamName: team.name,
        roleCode: seat.roleCode,
        minLevel: seat.minLevel,
        minHours: seat.minHours,
        stack: seat.stack,
        openedAt: seat.openedAt,
        teamTimezone: team.timezone,
        teamHoursPerWeek: team.hoursPerWeek,
        leadUserId: team.leadUserId,
      })
      .from(seat)
      .innerJoin(team, eq(team.id, seat.teamId))
      .where(and(...conditions))
      .orderBy(asc(seat.id))
      .limit(query.limit);
    if (rows.length === 0) return [];
    const teamIds = [...new Set(rows.map((r) => r.teamId))];
    const members = await db
      .select({ teamId: membership.teamId, userId: membership.userId })
      .from(membership)
      .where(and(inArray(membership.teamId, teamIds), eq(membership.status, 'active')));
    const byTeam = new Map<string, string[]>();
    for (const m of members) byTeam.set(m.teamId, [...(byTeam.get(m.teamId) ?? []), m.userId]);
    return rows.map((r) => ({
      ...r,
      minLevel: r.minLevel as Level,
      memberUserIds: byTeam.get(r.teamId) ?? [],
    }));
  }

  async seatBelongsToTeam(teamId: TeamId, seatId: SeatId): Promise<boolean> {
    const rows = await this.tx.tx
      .select({ id: seat.id })
      .from(seat)
      .where(and(eq(seat.id, seatId), eq(seat.teamId, teamId)))
      .limit(1);
    return rows.length > 0;
  }

  async getTeamNames(teamIds: TeamId[]): Promise<Map<TeamId, string>> {
    if (teamIds.length === 0) return new Map();
    const rows = await this.tx.tx
      .select({ id: team.id, name: team.name })
      .from(team)
      .where(inArray(team.id, teamIds));
    return new Map(rows.map((r) => [r.id, r.name]));
  }

  async getTeamBriefs(teamIds: TeamId[]): Promise<Map<TeamId, TeamBrief>> {
    if (teamIds.length === 0) return new Map();
    const rows = await this.tx.tx
      .select({
        teamId: team.id,
        name: team.name,
        description: team.description,
        createdAt: team.createdAt,
        startedAt: team.startedAt,
      })
      .from(team)
      .where(inArray(team.id, teamIds));
    return new Map(rows.map((r) => [r.teamId, r]));
  }

  async lockTeam(teamId: TeamId, mode: 'update' | 'share' = 'update'): Promise<TeamLockView> {
    const locked = await this.locks.lockTeam(teamId, mode);
    if (locked === undefined) throw new DomainError('NOT_FOUND', 404);
    const view = await this.getTeamView(teamId);
    if (view === null) throw new DomainError('NOT_FOUND', 404);
    return view;
  }

  /**
   * The current roster and seats, and the members who left during the project (FR-REW-02): a member who
   * left and came back is in the roster, so he is not listed as departed.
   */
  async getCompletionRosterSnapshot(teamId: TeamId): Promise<RosterSnapshot> {
    const members = await this.getRoster(teamId);
    const seats = await this.tx.tx
      .select()
      .from(seat)
      .where(eq(seat.teamId, teamId))
      .orderBy(asc(seat.roleCode), asc(seat.ordinal));
    const holders = await this.tx.tx
      .select()
      .from(seatAssignment)
      .where(and(eq(seatAssignment.teamId, teamId), isNull(seatAssignment.endedAt)));
    const left = await this.tx.tx
      .select({ userId: membership.userId })
      .from(membership)
      .where(and(eq(membership.teamId, teamId), inArray(membership.status, ['left', 'removed'])))
      .orderBy(asc(membership.userId));
    const activeIds = new Set(members.map((m) => m.userId));
    return {
      members,
      seats: seats
        .filter((s) => s.status !== 'closed')
        .map((s) => ({
          seatId: s.id,
          roleCode: s.roleCode,
          desired: s.desired,
          desiredChangedAt: s.desiredChangedAt,
          holderUserId: holders.find((h) => h.seatId === s.id)?.userId ?? null,
        })),
      departedUserIds: [...new Set(left.map((m) => m.userId))].filter((id) => !activeIds.has(id)),
    };
  }

  async markCompleted(teamId: TeamId, completedAt: Date): Promise<void> {
    await this.updateLocked(teamId, { status: 'completed', completedAt, updatedAt: completedAt });
  }

  async setReleaseUrl(teamId: TeamId, url: string | null): Promise<void> {
    await this.updateLocked(teamId, { releaseUrl: url === null ? null : canonicalReleaseUrl(url) });
  }

  async listCompletedTeamsByReleaseKey(
    releaseKey: string,
    exceptTeamId: TeamId,
  ): Promise<TeamId[]> {
    const rows = await this.tx.tx
      .select({ teamId: team.id })
      .from(team)
      .where(
        and(
          eq(team.releaseKey, releaseKey),
          eq(team.status, 'completed'),
          sql`${team.id} <> ${exceptTeamId}`,
        ),
      );
    return rows.map((r) => r.teamId);
  }

  private async updateLocked(teamId: TeamId, set: Partial<TeamRow>): Promise<void> {
    if (!this.tx.isActive()) throw new InvariantError('TeamsApi write outside a transaction');
    const rows = await this.tx.tx.update(team).set(set).where(eq(team.id, teamId)).returning({
      id: team.id,
    });
    if (rows.length === 0) throw new DomainError('NOT_FOUND', 404);
  }
}
