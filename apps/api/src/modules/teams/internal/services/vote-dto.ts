import type { Schema } from 'shared';
import { quorumOf } from '../domain/leader-vote-machine.js';
import type {
  LeaderVoteRow,
  VoteCandidateRow,
  VoteOfferRow,
} from '../repositories/leader-vote.repository.js';

export type LeaderVoteDto = Schema<'LeaderVote'>;

export interface VoteViewData {
  vote: LeaderVoteRow;
  candidates: VoteCandidateRow[];
  /** Eligible user ids of the snapshot. */
  eligible: Set<string>;
  ballotsCast: number;
  myBallotCast: boolean;
  offer: VoteOfferRow | undefined;
  /** Counts per candidate; only passed once the vote is closed (FR-TEAM-21). */
  tally: Map<string, number> | undefined;
  viewerId: string;
}

/** Never carries who voted for whom (FR-TEAM-21): only per-candidate counts after the close. */
export function toVoteDto(data: VoteViewData): LeaderVoteDto {
  const { vote } = data;
  const voting = vote.status === 'voting' || vote.status === 'runoff';
  const eligible = data.eligible.has(data.viewerId);
  return {
    id: vote.id,
    teamId: vote.teamId,
    trigger: vote.trigger as LeaderVoteDto['trigger'],
    status: vote.status as LeaderVoteDto['status'],
    round: vote.round as 1 | 2,
    openedAt: vote.openedAt.toISOString(),
    phaseDeadline: vote.phaseDeadline?.toISOString() ?? null,
    extended: vote.extended,
    eligibleCount: vote.eligibleCount,
    quorum: quorumOf(vote.eligibleCount),
    candidates: data.candidates.map((c) => ({
      userId: c.userId,
      confirmed: c.consentAt !== null,
      withdrawn: c.withdrawnAt !== null,
      votes: data.tally === undefined ? null : (data.tally.get(c.userId) ?? 0),
    })),
    ballotsCast: data.ballotsCast,
    myBallotCast: data.myBallotCast,
    canVote: voting && eligible && !data.myBallotCast,
    canNominate: vote.status === 'nominating' && eligible,
    pendingOffer:
      data.offer === undefined
        ? null
        : {
            userId: data.offer.userId,
            kind: data.offer.kind as 'winner_confirmation' | 'senior_offer',
            expiresAt: data.offer.expiresAt.toISOString(),
          },
    outcome: (vote.outcome ?? null) as LeaderVoteDto['outcome'],
    winnerUserId: vote.winnerUserId,
    randomTieBreak: vote.randomTieBreak,
  };
}
