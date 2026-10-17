import { Inject, Injectable } from '@nestjs/common';
import { ClsService } from 'nestjs-cls';
import { uuidv7 } from 'uuidv7';
import { Clock } from '../../../../platform/clock/clock.js';
import { DomainError, InvariantError } from '../../../../platform/errors/domain-error.js';
import { OutboxService } from '../../../../platform/outbox/outbox.service.js';
import { LockService } from '../../../../platform/tx/locks.js';
import { TxRunner } from '../../../../platform/tx/tx-runner.js';
import { AUTH_API, type AuthApi } from '../../../auth/public.js';
import {
  DEFICIT_PORT,
  type DeficitPort,
  type JoinRejectCode,
  type JoinSeatInput,
  type JoinSeatResult,
} from '../../public.js';
import { type JoinFacts, TRIAL_MS, joinRefusal } from '../domain/join-rules.js';
import { JoinRepository } from '../repositories/join.repository.js';
import { SeatRepository } from '../repositories/seat.repository.js';
import { TeamEventRepository } from '../repositories/team-event.repository.js';
import { type MembershipRow, TeamRepository } from '../repositories/team.repository.js';
import { journalRow, teamsEvent } from './team-events.js';

interface RawTeam {
  id: string;
  status: string;
  member_count: number;
}

interface RawSeat {
  id: string;
  team_id: string;
  role_code: string;
  status: string;
  version: number;
}

interface Locked {
  team: RawTeam;
  seat: RawSeat;
}

const reject = (code: JoinRejectCode): JoinSeatResult => ({ ok: false, code });

/**
 * The single path to a seat (T1/T2, CC-1, CC-2, FR-TEAM-04..07, FR-TEAM-25). Lock order: #1 user
 * (taken by the caller or here), #4 team, #5 seat. Every "is it free?" check runs under those
 * locks; the unique indexes `seat_assignment_active_seat_uq`, `seat_assignment_active_role_uq` and
 * `membership_active_uq` stay as the last guard (a violation maps to SEAT_TAKEN / ALREADY_MEMBER).
 */
@Injectable()
export class JoinService {
  constructor(
    @Inject(TxRunner) private readonly tx: TxRunner,
    @Inject(Clock) private readonly clock: Clock,
    @Inject(LockService) private readonly locks: LockService,
    @Inject(ClsService) private readonly cls: ClsService,
    @Inject(OutboxService) private readonly outbox: OutboxService,
    @Inject(AUTH_API) private readonly auth: AuthApi,
    @Inject(DEFICIT_PORT) private readonly deficit: DeficitPort,
    @Inject(TeamRepository) private readonly teams: TeamRepository,
    @Inject(SeatRepository) private readonly seats: SeatRepository,
    @Inject(JoinRepository) private readonly joins: JoinRepository,
    @Inject(TeamEventRepository) private readonly events: TeamEventRepository,
  ) {}

  async join(input: JoinSeatInput): Promise<JoinSeatResult> {
    if (!this.tx.isActive()) throw new InvariantError('TeamsApi.joinSeat outside a transaction');
    const gate = await this.eligibilityRefusal(input);
    if (gate !== undefined) return reject(gate);
    const teamId = await this.joins.teamOfSeat(input.seatId);
    if (teamId === undefined) return reject('SEAT_NOT_OPEN');
    const locked = await this.lockTeamAndSeat(teamId, input.seatId);
    if (locked === undefined) return reject('SEAT_NOT_OPEN');
    const membership = await this.joins.activeMembership(teamId, input.userId);
    const refusal = joinRefusal(await this.factsOf(locked, input.userId, membership));
    return refusal === undefined ? this.admit(input, locked, membership) : reject(refusal);
  }

  /** Lock #1 (unless the caller holds it) and the account rules of FR-AUTH-05 / FR-AUTH-03. */
  private async eligibilityRefusal(input: JoinSeatInput): Promise<JoinRejectCode | undefined> {
    const eligibility = input.userLocked
      ? this.heldEligibility(input.userId)
      : await this.lockUser(input.userId);
    if (eligibility === 'USER_INACTIVE') return eligibility;
    if (eligibility.githubUserId === null) return 'GITHUB_REQUIRED';
    return eligibility.consentValid ? undefined : 'CONSENT_REQUIRED';
  }

  /** `userLocked: true` is verified, never trusted: lock #1 must be recorded in this transaction. */
  private heldEligibility(userId: string): { githubUserId: number | null; consentValid: boolean } {
    const held = this.cls.get('lockedUsers')?.[userId];
    if (held === undefined) {
      throw new InvariantError(
        'joinSeat(userLocked) without lock #1 on the user in this transaction',
      );
    }
    return held;
  }

  private async lockUser(
    userId: string,
  ): Promise<{ githubUserId: number | null; consentValid: boolean } | 'USER_INACTIVE'> {
    try {
      return await this.auth.lockUserForJoin(userId);
    } catch (error) {
      if (error instanceof DomainError && error.code === 'USER_INACTIVE') return 'USER_INACTIVE';
      throw error;
    }
  }

  /** #4 team, then #5 seat; a seat of another team is treated as missing. */
  private async lockTeamAndSeat(teamId: string, seatId: string): Promise<Locked | undefined> {
    const team = await this.locks.lockTeam<RawTeam & Record<string, unknown>>(teamId);
    if (team === undefined) return undefined;
    const [seat] = await this.locks.lockSeats<RawSeat & Record<string, unknown>>([seatId]);
    return seat === undefined || seat.team_id !== teamId ? undefined : { team, seat };
  }

  private async factsOf(
    { team, seat }: Locked,
    userId: string,
    membership: MembershipRow | undefined,
  ): Promise<JoinFacts> {
    return {
      teamStatus: team.status,
      memberCount: team.member_count,
      seatStatus: seat.status,
      seatRole: seat.role_code,
      isMember: membership !== undefined,
      heldRoles: membership === undefined ? [] : await this.joins.heldRoles(membership.id),
      activeProjects: membership === undefined ? await this.teams.countActiveProjects(userId) : 0,
    };
  }

  private async admit(
    input: JoinSeatInput,
    { team, seat }: Locked,
    existing: MembershipRow | undefined,
  ): Promise<JoinSeatResult> {
    const now = this.clock.now();
    // FR-TEAM-25: matching knows the demand across all teams, so teams passes no count of its own.
    // Asked before the member is counted: a join that fills the team to 8 would otherwise take the
    // team (and its seat) out of the open seats before they are counted.
    const deficit = await this.deficit.evaluate({
      roleCode: seat.role_code,
      openSeats: 0,
      joiningUserId: input.userId,
      via: input.via,
    });
    const member = existing ?? (await this.createMembership(input, team.id, now));
    await this.joins.insertAssignment({
      id: uuidv7(),
      seatId: seat.id,
      teamId: team.id,
      membershipId: member.id,
      userId: input.userId,
      roleCode: seat.role_code,
      joinedVia: input.via,
      startedAt: now,
      deficitAtJoin: deficit.deficit,
      deficitOpenSeats: deficit.openSeats,
      deficitQueued: deficit.queued,
    });
    await this.seats.update(seat.id, { status: 'filled', version: seat.version + 1 });
    await this.record(input, team.id, seat, member, deficit.deficit, now);
    return {
      ok: true,
      teamId: team.id,
      seatId: seat.id,
      roleCode: seat.role_code,
      membershipId: member.id,
      trialUntil: member.trialUntil,
      deficitAtJoin: deficit.deficit,
    };
  }

  /** A new member: the membership row and the C-02 counter (under the team lock). */
  private async createMembership(
    input: JoinSeatInput,
    teamId: string,
    now: Date,
  ): Promise<MembershipRow> {
    const row: MembershipRow = {
      id: uuidv7(),
      teamId,
      userId: input.userId,
      status: 'active',
      joinedVia: input.via,
      joinedAt: now,
      trialUntil: input.via === 'auto' ? new Date(now.getTime() + TRIAL_MS) : null,
      trialConfirmedAt: null,
      applicationId: input.applicationId ?? null,
      leftAt: null,
      leftReason: null,
    };
    await this.teams.insertMembership(row);
    await this.joins.addMember(teamId, now);
    return row;
  }

  private async record(
    input: JoinSeatInput,
    teamId: string,
    seat: RawSeat,
    member: MembershipRow,
    deficitAtJoin: boolean,
    now: Date,
  ): Promise<void> {
    const journal = { seatId: seat.id, roleCode: seat.role_code, via: input.via };
    await this.events.insertMany([journalRow(teamId, 'member_joined', input.userId, journal, now)]);
    await this.outbox.publishMany([
      teamsEvent('member_joined', teamId, {
        teamId,
        userId: input.userId,
        seatId: seat.id,
        roleCode: seat.role_code,
        via: input.via,
        trialUntil: member.trialUntil?.toISOString() ?? null,
        deficitAtJoin,
      }),
    ]);
  }
}
