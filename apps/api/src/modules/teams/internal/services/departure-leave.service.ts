import { Inject, Injectable } from '@nestjs/common';
import { PinoLogger } from 'nestjs-pino';
import { uuidv7 } from 'uuidv7';
import { Clock } from '../../../../platform/clock/clock.js';
import { DomainError } from '../../../../platform/errors/domain-error.js';
import { OutboxService } from '../../../../platform/outbox/outbox.service.js';
import { jobId } from '../../../../platform/queues/job-id.js';
import { QueuesService } from '../../../../platform/queues/queues.service.js';
import { LockService } from '../../../../platform/tx/locks.js';
import { TxRunner } from '../../../../platform/tx/tx-runner.js';
import { AUTH_API, type AuthApi } from '../../../auth/public.js';
import { departureDueAt } from '../domain/departure-rules.js';
import {
  LEADER_VOTE_LEAVE_PORT,
  type LeaderVoteLeavePort,
} from '../ports/leader-vote-leave.port.js';
import { LEADER_VOTE_OPEN_PORT, type LeaderVoteOpenPort } from '../ports/leader-vote-open.port.js';
import { DepartureRepository } from '../repositories/departure.repository.js';
import { JoinRepository } from '../repositories/join.repository.js';
import { SeatRepository } from '../repositories/seat.repository.js';
import { TeamEventRepository } from '../repositories/team-event.repository.js';
import { journalRow, teamsEvent } from './team-events.js';

export const DEPARTURE_DEFAULT_JOB = 'departure-default';

interface RawTeam {
  id: string;
  status: string;
  lead_user_id: string | null;
  /** C-02 counter as it was before this leave. */
  member_count: number;
}

interface RawSeat {
  id: string;
  version: number;
}

interface Held {
  seatId: string;
  roleCode: string;
}

interface Left {
  departureId: string | null;
  dueAt: Date;
}

/**
 * leaveTeam (FR-TEAM-11, -12, -14). Lock order: #1 user -> #4 team -> #5 seats -> #6 membership -> #7 vote (taken by `LeaderVoteLeavePort`).
 * The seats of the leaver open again in the same transaction; a leaving member opens a `departure`
 * for the lead (default after 7 days, C-14); a leaving lead opens the leader vote through
 * `LeaderVoteOpenPort` (S3-07) and leaves no departure, because there is nobody to decide it.
 */
@Injectable()
export class DepartureLeaveService {
  constructor(
    @Inject(TxRunner) private readonly tx: TxRunner,
    @Inject(Clock) private readonly clock: Clock,
    @Inject(LockService) private readonly locks: LockService,
    @Inject(OutboxService) private readonly outbox: OutboxService,
    @Inject(QueuesService) private readonly queues: QueuesService,
    @Inject(PinoLogger) private readonly logger: PinoLogger,
    @Inject(AUTH_API) private readonly auth: AuthApi,
    @Inject(LEADER_VOTE_OPEN_PORT) private readonly voteOpen: LeaderVoteOpenPort,
    @Inject(LEADER_VOTE_LEAVE_PORT) private readonly voteLeave: LeaderVoteLeavePort,
    @Inject(JoinRepository) private readonly joins: JoinRepository,
    @Inject(SeatRepository) private readonly seats: SeatRepository,
    @Inject(DepartureRepository) private readonly departures: DepartureRepository,
    @Inject(TeamEventRepository) private readonly events: TeamEventRepository,
  ) {}

  async leave(userId: string, teamId: string): Promise<void> {
    const left = await this.tx.run(() => this.leaveInTx(userId, teamId));
    if (left.departureId !== null) await this.scheduleDefault(left.departureId, left.dueAt);
  }

  private async leaveInTx(userId: string, teamId: string): Promise<Left> {
    await this.auth.lockUserForJoin(userId);
    const team = await this.locks.lockTeam<RawTeam & Record<string, unknown>>(teamId);
    if (team === undefined) throw new DomainError('NOT_FOUND', 404);
    const member = await this.joins.activeMembership(teamId, userId);
    if (member === undefined) throw new DomainError('NOT_FOUND', 404);
    if (team.status === 'completed' || team.status === 'archived') {
      throw new DomainError('INVALID_STATE', 409);
    }
    const held: Held[] = await this.joins.activeAssignments(member.id);
    const seatIds = held.map((h) => h.seatId).sort();
    const lockedSeats = await this.locks.lockSeats<RawSeat & Record<string, unknown>>(seatIds);
    await this.locks.lockMembership(member.id);
    const now = this.clock.now();
    await this.joins.endAssignments(member.id, now);
    await this.joins.markLeft(member.id, now, 'left');
    await this.joins.removeMember(teamId, now);
    for (const locked of lockedSeats) {
      await this.seats.update(locked.id, {
        status: 'open',
        openedAt: now,
        version: locked.version + 1,
      });
    }
    const isLead = team.lead_user_id === userId;
    const { archived } = await this.voteLeave.afterLeave({
      teamId,
      userId,
      remaining: team.member_count - 1,
      wasLead: isLead,
      at: now,
    });
    // An archived team has nobody to decide a departure, and a leaving lead leaves none anyway.
    const left =
      isLead || archived
        ? { departureId: null, dueAt: departureDueAt(now) }
        : await this.openDecision({ teamId, userId, membershipId: member.id, seatIds }, now);
    if (isLead && !archived) {
      await this.voteOpen.open({ teamId, leaderUserId: userId, trigger: 'lead_left', at: now });
    }
    await this.record(teamId, userId, held, now);
    return left;
  }

  private async openDecision(
    who: { teamId: string; userId: string; membershipId: string; seatIds: string[] },
    now: Date,
  ): Promise<Left> {
    const dueAt = departureDueAt(now);
    if (who.seatIds.length === 0) return { departureId: null, dueAt };
    const id = uuidv7();
    await this.departures.insert({
      id,
      teamId: who.teamId,
      membershipId: who.membershipId,
      userId: who.userId,
      seatIds: who.seatIds,
      reason: 'left',
      decision: 'pending',
      dueAt,
    });
    return { departureId: id, dueAt };
  }

  private async record(teamId: string, userId: string, held: Held[], now: Date): Promise<void> {
    const seatIds = held.map((h) => h.seatId);
    await this.events.insertMany([
      journalRow(teamId, 'member_left', userId, { reason: 'left', seatIds }, now),
    ]);
    await this.outbox.publishMany([
      teamsEvent('member_left', teamId, { teamId, userId, reason: 'left', seatIds }),
      ...held.map((h) =>
        teamsEvent('seat_opened', h.seatId, {
          seatId: h.seatId,
          teamId,
          roleCode: h.roleCode,
          openedAt: now.toISOString(),
        }),
      ),
    ]);
  }

  /**
   * After COMMIT: the delayed `departure-default` job (C-14). A deterministic job id makes a second
   * add a no-op. If Redis is down the decision stays `pending` and the lead can still take it.
   */
  private async scheduleDefault(departureId: string, dueAt: Date): Promise<void> {
    try {
      await this.queues.add(
        'timers',
        DEPARTURE_DEFAULT_JOB,
        { departureId },
        {
          jobId: jobId('departuredefault', departureId, 'due'),
          delayMs: Math.max(0, dueAt.getTime() - this.clock.now().getTime()),
        },
      );
    } catch (error) {
      this.logger.error({ err: error, departureId }, 'departure-default timer was not scheduled');
    }
  }
}
