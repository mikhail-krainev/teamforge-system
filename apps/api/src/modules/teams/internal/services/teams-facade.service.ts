import { Inject, Injectable } from '@nestjs/common';
import { and, asc, eq, isNull } from 'drizzle-orm';
import { DomainError, InvariantError } from '../../../../platform/errors/domain-error.js';
import { LockService } from '../../../../platform/tx/locks.js';
import { TxRunner } from '../../../../platform/tx/tx-runner.js';
import type {
  JoinSeatResult,
  RosterMember,
  RosterSnapshot,
  TeamId,
  TeamLockView,
  TeamStatus,
  TeamsApi,
  UserId,
} from '../../public.js';
import { membership, seat, seatAssignment, team } from '../schema/teams.js';

type TeamRow = typeof team.$inferSelect;

function toView(row: TeamRow): TeamLockView {
  return {
    teamId: row.id,
    status: row.status as TeamStatus,
    leadUserId: row.leadUserId,
    memberCount: row.memberCount,
    startedAt: row.startedAt,
    plannedEndAt: row.plannedEndAt,
    playbookId: row.playbookId,
    productType: row.productTypeCode,
  };
}

/** Facade of the teams module (`TeamsApi`). `joinSeat` arrives with the join service (S3-04). */
@Injectable()
export class TeamsFacade implements TeamsApi {
  constructor(
    @Inject(TxRunner) private readonly tx: TxRunner,
    @Inject(LockService) private readonly locks: LockService,
  ) {}

  async getTeamView(teamId: TeamId): Promise<TeamLockView | null> {
    const rows = await this.tx.tx.select().from(team).where(eq(team.id, teamId));
    return rows[0] === undefined ? null : toView(rows[0]);
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

  joinSeat(): Promise<JoinSeatResult> {
    return Promise.reject(new InvariantError('TeamsApi.joinSeat is implemented in S3-04'));
  }

  async lockTeam(teamId: TeamId, mode: 'update' | 'share' = 'update'): Promise<TeamLockView> {
    const locked = await this.locks.lockTeam(teamId, mode);
    if (locked === undefined) throw new DomainError('NOT_FOUND', 404);
    const view = await this.getTeamView(teamId);
    if (view === null) throw new DomainError('NOT_FOUND', 404);
    return view;
  }

  /**
   * Stub until slice 6: the current roster and seats, nobody departed. The real snapshot adds the
   * members who left during the project (FR-REW-02).
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
      departedUserIds: [],
    };
  }

  async markCompleted(teamId: TeamId, completedAt: Date): Promise<void> {
    await this.updateLocked(teamId, { status: 'completed', completedAt, updatedAt: completedAt });
  }

  async setReleaseUrl(teamId: TeamId, url: string): Promise<void> {
    await this.updateLocked(teamId, { releaseUrl: url });
  }

  private async updateLocked(teamId: TeamId, set: Partial<TeamRow>): Promise<void> {
    if (!this.tx.isActive()) throw new InvariantError('TeamsApi write outside a transaction');
    const rows = await this.tx.tx.update(team).set(set).where(eq(team.id, teamId)).returning({
      id: team.id,
    });
    if (rows.length === 0) throw new DomainError('NOT_FOUND', 404);
  }
}
