import { Inject, Injectable } from '@nestjs/common';
import { Clock } from '../../../../platform/clock/clock.js';
import { DomainError } from '../../../../platform/errors/domain-error.js';
import { OutboxService } from '../../../../platform/outbox/outbox.service.js';
import { LockService } from '../../../../platform/tx/locks.js';
import { TxRunner } from '../../../../platform/tx/tx-runner.js';
import { trialRanOut, trialRefusal } from '../domain/trial-rules.js';
import { JoinRepository } from '../repositories/join.repository.js';
import { SeatRepository } from '../repositories/seat.repository.js';
import { TeamEventRepository } from '../repositories/team-event.repository.js';
import { type MembershipRow } from '../repositories/team.repository.js';
import { TrialRepository } from '../repositories/trial.repository.js';
import { journalRow, teamsEvent } from './team-events.js';
import { TeamLeadLock } from './team-lead-lock.js';
import type { MemberDto } from './team-dto.js';
import { TeamViewService } from './team-view.service.js';

interface RawSeat {
  id: string;
  version: number;
}

interface Held {
  seatId: string;
  roleCode: string;
}

/**
 * The trial period of an auto-added member (FR-TEAM-22, -24, FR-MATCH-08). Lock order: #4 team
 * -> #5 seats -> #6 membership, the same as `leaveTeam`, so an exclusion, a confirmation, a leave
 * and the expiry timer of one member serialize on the team and exactly one of them wins; the
 * checks `joined_via = 'auto' AND trial_until > :now AND trial_confirmed_at IS NULL` run under
 * those locks (architecture 12.3).
 */
@Injectable()
export class TrialService {
  constructor(
    @Inject(TxRunner) private readonly tx: TxRunner,
    @Inject(Clock) private readonly clock: Clock,
    @Inject(LockService) private readonly locks: LockService,
    @Inject(OutboxService) private readonly outbox: OutboxService,
    @Inject(TeamLeadLock) private readonly leadLock: TeamLeadLock,
    @Inject(TrialRepository) private readonly trials: TrialRepository,
    @Inject(JoinRepository) private readonly joins: JoinRepository,
    @Inject(SeatRepository) private readonly seats: SeatRepository,
    @Inject(TeamEventRepository) private readonly events: TeamEventRepository,
    @Inject(TeamViewService) private readonly view: TeamViewService,
  ) {}

  /** excludeTrialMember: the lead removes an auto-added member, the seat opens again. */
  async exclude(leadUserId: string, teamId: string, userId: string): Promise<void> {
    await this.tx.run(() => this.excludeInTx(leadUserId, teamId, userId));
  }

  /** confirmTrial: the lead ends the trial early; the member is a full member from now on. */
  async confirm(leadUserId: string, teamId: string, userId: string): Promise<MemberDto> {
    await this.tx.run(() => this.confirmInTx(leadUserId, teamId, userId));
    const team = await this.view.team(teamId, leadUserId);
    const member = team.members.find((m) => m.userId === userId);
    if (member === undefined) throw new DomainError('NOT_FOUND', 404);
    return member;
  }

  /**
   * The `trial-expire` timer: a trial that ran out unconfirmed is closed (`trial_confirmed_at`),
   * and the member stays. Early or repeated firing does nothing. Returns whether it closed one.
   */
  expire(membershipId: string): Promise<boolean> {
    return this.tx.run(() => this.expireInTx(membershipId));
  }

  private async excludeInTx(leadUserId: string, teamId: string, userId: string): Promise<void> {
    const team = await this.leadLock.lock(teamId, leadUserId);
    const found = await this.trials.findActive(teamId, userId);
    if (found === undefined) throw new DomainError('NOT_FOUND', 404);
    if (userId === team.leadUserId) throw new DomainError('INVALID_STATE', 409);
    const held: Held[] = await this.joins.activeAssignments(found.id);
    const seatIds = held.map((h) => h.seatId).sort();
    const lockedSeats = await this.locks.lockSeats<RawSeat & Record<string, unknown>>(seatIds);
    await this.locks.lockMembership(found.id);
    const member = await this.trials.find(found.id);
    if (member === undefined || member.status !== 'active') throw new DomainError('NOT_FOUND', 404);
    const now = this.clock.now();
    const refusal = trialRefusal(member, now);
    if (refusal !== undefined) throw new DomainError(refusal, 409);
    await this.joins.endAssignments(member.id, now);
    await this.trials.markRemovedInTrial(member.id, now);
    await this.joins.removeMember(teamId, now);
    for (const locked of lockedSeats) {
      await this.seats.update(locked.id, {
        status: 'open',
        openedAt: now,
        version: locked.version + 1,
      });
    }
    await this.recordExclusion(member, held, now);
  }

  private async recordExclusion(member: MembershipRow, held: Held[], now: Date): Promise<void> {
    const { teamId, userId } = member;
    const seatIds = held.map((h) => h.seatId);
    await this.events.insertMany([
      journalRow(teamId, 'member_left', userId, { reason: 'removed_in_trial', seatIds }, now),
    ]);
    await this.outbox.publishMany([
      teamsEvent('member_excluded', teamId, {
        teamId,
        userId,
        applicationId: member.applicationId,
      }),
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

  private async confirmInTx(leadUserId: string, teamId: string, userId: string): Promise<void> {
    await this.leadLock.lock(teamId, leadUserId);
    const found = await this.trials.findActive(teamId, userId);
    if (found === undefined) throw new DomainError('NOT_FOUND', 404);
    await this.locks.lockMembership(found.id);
    const member = await this.trials.find(found.id);
    if (member === undefined || member.status !== 'active') throw new DomainError('NOT_FOUND', 404);
    // A second confirmation of the same member changes nothing and answers the same way.
    if (member.joinedVia === 'auto' && member.trialConfirmedAt !== null) return;
    const now = this.clock.now();
    const refusal = trialRefusal(member, now);
    if (refusal !== undefined) throw new DomainError(refusal, 409);
    await this.trials.confirmTrial(member.id, now);
  }

  private async expireInTx(membershipId: string): Promise<boolean> {
    const found = await this.trials.find(membershipId);
    if (found === undefined || found.status !== 'active') return false;
    if (found.joinedVia !== 'auto') return false;
    const team = await this.locks.lockTeam(found.teamId);
    if (team === undefined) return false;
    await this.locks.lockMembership(found.id);
    const member = await this.trials.find(found.id);
    if (member === undefined || member.status !== 'active') return false;
    const now = this.clock.now();
    if (!trialRanOut(member, now)) return false;
    await this.trials.confirmTrial(member.id, now);
    return true;
  }
}
