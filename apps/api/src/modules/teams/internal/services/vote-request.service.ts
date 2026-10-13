import { Inject, Injectable } from '@nestjs/common';
import { Clock } from '../../../../platform/clock/clock.js';
import { DomainError } from '../../../../platform/errors/domain-error.js';
import { LockService } from '../../../../platform/tx/locks.js';
import { TxRunner } from '../../../../platform/tx/tx-runner.js';
import { leadInactive, requestsRequired } from '../domain/leader-vote-machine.js';
import { JoinRepository } from '../repositories/join.repository.js';
import { LeaderVoteRepository } from '../repositories/leader-vote.repository.js';
import { TeamRepository } from '../repositories/team.repository.js';
import { VoteOpenService } from './vote-open.service.js';
import { type VoteRequestStatusDto, VoteQueryService } from './vote-query.service.js';

/**
 * requestLeaderVote (FR-TEAM-14, C-15): when the lead has been inactive for more than 14 days,
 * the requests of ceil(N/2) members open the vote. Lock #4 serializes the requests, so the last
 * one opens exactly one vote (CC-4 (b)); `leader_vote_open_uq` backs it up.
 */
@Injectable()
export class VoteRequestService {
  constructor(
    @Inject(TxRunner) private readonly tx: TxRunner,
    @Inject(Clock) private readonly clock: Clock,
    @Inject(LockService) private readonly locks: LockService,
    @Inject(TeamRepository) private readonly teams: TeamRepository,
    @Inject(JoinRepository) private readonly joins: JoinRepository,
    @Inject(LeaderVoteRepository) private readonly votes: LeaderVoteRepository,
    @Inject(VoteOpenService) private readonly opener: VoteOpenService,
    @Inject(VoteQueryService) private readonly query: VoteQueryService,
  ) {}

  async request(userId: string, teamId: string): Promise<VoteRequestStatusDto> {
    return this.tx.run(async () => {
      if ((await this.locks.lockTeam(teamId)) === undefined)
        throw new DomainError('NOT_FOUND', 404);
      const team = await this.teams.find(teamId);
      if (team === undefined) throw new DomainError('NOT_FOUND', 404);
      if ((await this.joins.activeMembership(teamId, userId)) === undefined) {
        throw new DomainError('NOT_FOUND', 404);
      }
      if ((await this.votes.findOpen(teamId)) !== undefined) {
        throw new DomainError('VOTE_ALREADY_OPEN', 409);
      }
      const now = this.clock.now();
      const eligibleStatus = team.status === 'forming' || team.status === 'active';
      if (
        !eligibleStatus ||
        team.leadUserId === null ||
        team.leadUserId === userId ||
        !leadInactive(team.leadLastActiveAt, now)
      ) {
        throw new DomainError('INVALID_STATE', 409);
      }
      await this.votes.insertRequest(teamId, userId, now);
      const requests = await this.votes.requestCount(teamId);
      const required = Math.max(1, requestsRequired(team.memberCount));
      if (requests < required) return { requests, required, voteId: null };
      const opened = await this.opener.openFor(team, 'lead_inactive', now);
      return { requests, required, voteId: opened?.voteId ?? null };
    });
  }

  status(teamId: string): Promise<VoteRequestStatusDto> {
    return this.query.requestStatus(teamId);
  }
}
