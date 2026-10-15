import { Inject, Injectable } from '@nestjs/common';
import {
  type CursorPayload,
  type Page,
  buildPage,
  clampLimit,
  decodeCursor,
} from '../../../../platform/db/pagination.js';
import { DomainError } from '../../../../platform/errors/domain-error.js';
import { requestsRequired } from '../domain/leader-vote-machine.js';
import {
  LeaderVoteRepository,
  type LeaderVoteRow,
  type VoteCursor,
} from '../repositories/leader-vote.repository.js';
import { TeamRepository } from '../repositories/team.repository.js';
import { type LeaderVoteDto, toVoteDto } from './vote-dto.js';

export interface VotesQuery {
  cursor?: string | undefined;
  limit?: number | undefined;
}

export interface VoteRequestStatusDto {
  requests: number;
  required: number;
  voteId: string | null;
}

function keysetOf(payload: CursorPayload): VoteCursor {
  const [at, id] = payload.k;
  const when = typeof at === 'string' ? new Date(at) : undefined;
  if (when === undefined || Number.isNaN(when.getTime()) || typeof id !== 'string') {
    throw new DomainError('VALIDATION_FAILED', 400, {
      errors: [{ pointer: '/cursor', code: 'invalid_cursor', message: 'Invalid cursor' }],
    });
  }
  return { openedAt: when, id };
}

/** listLeaderVotes, getLeaderVoteRequests and the vote view shared by the vote operations. */
@Injectable()
export class VoteQueryService {
  constructor(
    @Inject(LeaderVoteRepository) private readonly votes: LeaderVoteRepository,
    @Inject(TeamRepository) private readonly teams: TeamRepository,
  ) {}

  async list(viewerId: string, teamId: string, query: VotesQuery): Promise<Page<LeaderVoteDto>> {
    const filters = { teamId };
    const limit = clampLimit(query.limit);
    const after =
      query.cursor === undefined ? undefined : keysetOf(decodeCursor(query.cursor, filters));
    const rows = await this.votes.list(teamId, after, limit + 1);
    const page = buildPage(rows, limit, (row) => [row.openedAt.toISOString(), row.id], filters);
    const items: LeaderVoteDto[] = [];
    for (const row of page.items) items.push(await this.view(row, viewerId));
    return { items, nextCursor: page.nextCursor };
  }

  /** The vote of this team, or 404. */
  async get(viewerId: string, teamId: string, voteId: string): Promise<LeaderVoteDto> {
    const row = await this.votes.find(teamId, voteId);
    if (row === undefined) throw new DomainError('NOT_FOUND', 404);
    return this.view(row, viewerId);
  }

  async view(vote: LeaderVoteRow, viewerId: string): Promise<LeaderVoteDto> {
    const [candidates, eligible, ballotsCast, myBallotCast, offer] = await Promise.all([
      this.votes.candidatesOf(vote.id),
      this.votes.eligibleOf(vote.id),
      this.votes.ballotsCast(vote.id, vote.round),
      this.votes.hasBallot(vote.id, vote.round, viewerId),
      this.votes.pendingOffer(vote.id),
    ]);
    return toVoteDto({
      vote,
      candidates,
      eligible: new Set(eligible.map((e) => e.userId)),
      ballotsCast,
      myBallotCast,
      offer,
      tally: vote.status === 'closed' ? await this.finalTally(vote.id) : undefined,
      viewerId,
    });
  }

  /** The best count a candidate reached in any round; the voters are not read at all. */
  private async finalTally(voteId: string): Promise<Map<string, number>> {
    const best = new Map<string, number>();
    for (const row of await this.votes.tally(voteId)) {
      best.set(row.candidateUserId, Math.max(best.get(row.candidateUserId) ?? 0, row.n));
    }
    return best;
  }

  async requestStatus(teamId: string): Promise<VoteRequestStatusDto> {
    const team = await this.teams.find(teamId);
    if (team === undefined) throw new DomainError('NOT_FOUND', 404);
    const open = await this.votes.findOpen(teamId);
    return {
      requests: await this.votes.requestCount(teamId),
      required: Math.max(1, requestsRequired(team.memberCount)),
      voteId: open?.id ?? null,
    };
  }
}
