import { randomInt } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import { uuidv7 } from 'uuidv7';
import { InvariantError } from '../../../../platform/errors/domain-error.js';
import { OutboxService } from '../../../../platform/outbox/outbox.service.js';
import {
  OFFER_MS,
  isOpenStatus,
  phaseDeadline,
  quorumOf,
  transition,
  type VoteEvent,
  type VoteState,
  type VoteStatus,
  type VoteTransition,
} from '../domain/leader-vote-machine.js';
import {
  type CandidateScore,
  confirmationOrder,
  leadersOf,
  majorityHolder,
  resolveTie,
} from '../domain/vote-tally.js';
import { NO_LEADER_REASON, VoteTimers } from '../jobs/vote-deadline.js';
import {
  LeaderVoteRepository,
  type LeaderVoteRow,
  type VoteCandidateRow,
  type VoteOfferRow,
} from '../repositories/leader-vote.repository.js';
import { TeamEventRepository } from '../repositories/team-event.repository.js';
import { TeamRepository } from '../repositories/team.repository.js';
import type { leaderVote } from '../schema/votes.js';
import { statusJournalRow } from './start-events.js';
import { journalRow, teamsEvent } from './team-events.js';

export type OfferAnswer = 'accepted' | 'declined' | 'expired';

/** What a landing in the next phase needs besides the transition itself. */
interface Landing {
  /** The member who becomes the lead (the vote closes with him). */
  winner?: string;
  /** Candidates still to ask, best first (computed when the caller already knows them). */
  candidates?: CandidateScore[];
  /** Members still to ask for the lead role, longest-serving first. */
  seniors?: string[];
  /** Asked first although the ranking would say otherwise (the runoff was drawn by lot). */
  preferred?: string;
  byLot?: boolean;
}

type VoteSet = Partial<typeof leaderVote.$inferInsert>;

/** A candidate is on the ballot after his consent and until he withdraws. */
export function onBallot(c: VoteCandidateRow): boolean {
  return c.consentAt !== null && c.withdrawnAt === null;
}

/**
 * The transitions of the leader vote (architecture 8.2) with their effects: offers, closing, the
 * lead change, the suspension of the team, the outbox and the timers. Every method runs inside a
 * transaction that holds lock #4 (team) and #7 (vote); nothing here takes locks itself.
 */
@Injectable()
export class VoteFlowService {
  constructor(
    @Inject(OutboxService) private readonly outbox: OutboxService,
    @Inject(TeamRepository) private readonly teams: TeamRepository,
    @Inject(LeaderVoteRepository) private readonly votes: LeaderVoteRepository,
    @Inject(TeamEventRepository) private readonly events: TeamEventRepository,
    @Inject(VoteTimers) private readonly timers: VoteTimers,
  ) {}

  stateOf(vote: LeaderVoteRow): VoteState {
    return {
      status: vote.status as VoteStatus,
      round: vote.round === 2 ? 2 : 1,
      extended: vote.extended,
    };
  }

  /** Moves a vote whose phase is over to the next one. `false` when it is not due. */
  async processDue(vote: LeaderVoteRow, now: Date): Promise<boolean> {
    if (!isOpenStatus(vote.status) || vote.phaseDeadline === null) return false;
    if (vote.phaseDeadline.getTime() > now.getTime()) return false;
    switch (vote.status) {
      case 'nominating':
        await this.nominationOver(vote, now);
        return true;
      case 'voting':
        await this.votingOver(vote, now);
        return true;
      case 'runoff':
        await this.runoffOver(vote, now);
        return true;
      case 'confirming':
      case 'offering':
        await this.answer(vote, await this.votes.pendingOffer(vote.id), 'expired', now);
        return true;
      default:
        return false;
    }
  }

  /** FR-TEAM-17: a ballot that gives a candidate more than N/2 closes the voting at once. */
  async afterBallot(vote: LeaderVoteRow, now: Date): Promise<void> {
    if (vote.status !== 'voting') return;
    const holder = majorityHolder(await this.scores(vote, 'first'), vote.eligibleCount);
    if (holder === undefined) return;
    await this.land(vote, this.must(this.stateOf(vote), { type: 'majority_reached' }), now);
  }

  /** The addressee of the pending offer answered, or the time for the answer ran out. */
  async answer(
    vote: LeaderVoteRow,
    offer: VoteOfferRow | undefined,
    answer: OfferAnswer,
    now: Date,
  ): Promise<void> {
    if (offer !== undefined) {
      await this.votes.updateOffer(offer.id, { status: answer, answeredAt: now });
    }
    const state = this.stateOf(vote);
    if (answer === 'accepted') {
      if (offer === undefined) throw new InvariantError('an accepted offer is needed');
      await this.land(vote, this.must(state, { type: 'offer_accepted' }), now, {
        winner: offer.userId,
      });
      return;
    }
    if (vote.status === 'offering') {
      const seniors = await this.seniorPool(vote);
      const next = this.must(state, { type: 'senior_declined', membersLeft: seniors.length });
      await this.land(vote, next, now, { seniors });
      return;
    }
    const candidates = await this.confirmationPool(vote);
    const next = this.must(state, {
      type: 'confirmation_declined',
      candidatesLeft: candidates.length,
    });
    await this.land(vote, next, now, { candidates });
  }

  /**
   * The last member left (FR-TEAM-14): the vote ends with the team, so a pending offer is
   * withdrawn and the vote closes as `archived`. The caller archives the team.
   */
  async closeEmptied(vote: LeaderVoteRow, offer: VoteOfferRow | undefined, now: Date) {
    if (offer !== undefined) {
      await this.votes.updateOffer(offer.id, { status: 'expired', answeredAt: now });
    }
    await this.persist(vote, this.must(this.stateOf(vote), { type: 'team_emptied' }), now, {});
  }

  private async nominationOver(vote: LeaderVoteRow, now: Date): Promise<void> {
    const confirmed = (await this.votes.candidatesOf(vote.id)).filter(onBallot).length;
    const event: VoteEvent = { type: 'nomination_deadline', confirmedCandidates: confirmed };
    await this.land(vote, this.must(this.stateOf(vote), event), now);
  }

  /** Quorum counts the ballots cast; with nobody left on the ballot the phase just ends (8.2). */
  private async votingOver(vote: LeaderVoteRow, now: Date): Promise<void> {
    const scores = await this.scores(vote, 'first');
    const ballots = await this.votes.ballotsCast(vote.id, 1);
    const quorum = scores.length === 0 || ballots >= quorumOf(vote.eligibleCount);
    const leaders = leadersOf(scores);
    const next = this.must(this.stateOf(vote), {
      type: 'voting_deadline',
      quorum,
      tie: leaders.length > 1,
    });
    if (next.status === 'runoff')
      await this.votes.markRunoff(
        vote.id,
        leaders.map((l) => l.userId),
      );
    await this.land(vote, next, now);
  }

  /** FR-TEAM-19: a second tie goes to the longer-serving member, else to a draw (journalled). */
  private async runoffOver(vote: LeaderVoteRow, now: Date): Promise<void> {
    const leaders = leadersOf(await this.scores(vote, 'runoff'));
    const landing: Landing = {};
    if (leaders.length > 1) {
      const resolved = resolveTie(leaders, (n) => randomInt(n));
      landing.preferred = resolved.winner.userId;
      landing.byLot = resolved.byLot;
      if (resolved.byLot) {
        await this.events.insertMany([
          journalRow(
            vote.teamId,
            'vote_tie_break',
            resolved.winner.userId,
            {
              voteId: vote.id,
              participants: leaders.map((l) => l.userId),
              winner: resolved.winner.userId,
            },
            now,
          ),
        ]);
      }
    }
    const next = this.must(this.stateOf(vote), {
      type: 'runoff_deadline',
      tie: leaders.length > 1,
    });
    await this.land(vote, next, now, landing);
  }

  /** Persists the phase `next` and does what entering it requires. */
  private async land(
    vote: LeaderVoteRow,
    next: VoteTransition,
    now: Date,
    landing: Landing = {},
  ): Promise<void> {
    switch (next.status) {
      case 'closed':
        return next.suspendTeam
          ? this.suspend(vote, next, now)
          : this.closeWithLead(vote, next, landing.winner, now);
      case 'confirming':
        return this.askCandidate(vote, next, now, landing);
      case 'offering':
        return this.askSenior(vote, next, now, landing);
      default:
        await this.persist(vote, next, now, {});
    }
  }

  private async askCandidate(
    vote: LeaderVoteRow,
    next: VoteTransition,
    now: Date,
    landing: Landing,
  ): Promise<void> {
    const pool =
      landing.candidates ??
      (await this.confirmationPool({ ...vote, round: next.round }, landing.preferred));
    const first = pool[0];
    if (first === undefined) {
      const none = this.must(next, { type: 'confirmation_declined', candidatesLeft: 0 });
      return this.land(vote, none, now);
    }
    const extra: VoteSet = landing.byLot === true ? { randomTieBreak: true } : {};
    const row = await this.persist(vote, next, now, extra, first.userId);
    await this.createOffer(row, first.userId, 'winner_confirmation', now);
  }

  private async askSenior(
    vote: LeaderVoteRow,
    next: VoteTransition,
    now: Date,
    landing: Landing,
  ): Promise<void> {
    const seniors = landing.seniors ?? (await this.seniorPool(vote));
    const first = seniors[0];
    if (first === undefined) {
      return this.land(vote, this.must(next, { type: 'senior_declined', membersLeft: 0 }), now);
    }
    const row = await this.persist(vote, next, now, {}, first);
    await this.createOffer(row, first, 'senior_offer', now);
  }

  private async closeWithLead(
    vote: LeaderVoteRow,
    next: VoteTransition,
    winner: string | undefined,
    now: Date,
  ): Promise<void> {
    if (winner === undefined) throw new InvariantError('a vote closes with a winner');
    const team = await this.teams.find(vote.teamId);
    if (team === undefined) throw new InvariantError('the team of the vote is gone');
    await this.persist(vote, next, now, { winnerUserId: winner });
    const restored = team.statusBeforeVote ?? 'active';
    const from = team.leadUserId ?? (await this.events.leadAtOpening(team.id, vote.id));
    await this.teams.update(team.id, {
      leadUserId: winner,
      status: restored,
      statusBeforeVote: null,
      leadLastActiveAt: now,
      updatedAt: now,
      version: team.version + 1,
    });
    await this.events.insertMany([
      journalRow(
        team.id,
        'lead_changed',
        winner,
        { from, to: winner, via: next.outcome, voteId: vote.id },
        now,
      ),
    ]);
    await this.outbox.publishMany([
      teamsEvent('lead_changed', team.id, {
        teamId: team.id,
        from,
        to: winner,
        fromUserId: from,
        toUserId: winner,
        via: next.outcome,
      }),
      teamsEvent('team_status_changed', team.id, {
        teamId: team.id,
        from: team.status,
        to: restored,
        reason: 'vote_closed',
      }),
    ]);
  }

  /** FR-TEAM-20: nobody wants to lead; the team is suspended for 14 days, then archived. */
  private async suspend(vote: LeaderVoteRow, next: VoteTransition, now: Date): Promise<void> {
    const team = await this.teams.find(vote.teamId);
    if (team === undefined) throw new InvariantError('the team of the vote is gone');
    await this.persist(vote, next, now, {});
    await this.teams.update(team.id, {
      status: 'suspended',
      statusReason: NO_LEADER_REASON,
      statusBeforeVote: null,
      suspendedAt: now,
      updatedAt: now,
      version: team.version + 1,
    });
    const change = { from: team.status, to: 'suspended', reason: NO_LEADER_REASON };
    await this.events.insertMany([
      statusJournalRow(team.id, 'team_status_changed', null, { ...change, voteId: vote.id }, now),
    ]);
    await this.outbox.publishMany([
      teamsEvent('team_status_changed', team.id, { teamId: team.id, ...change }),
    ]);
    await this.timers.scheduleSuspensionExpiry(team.id, now);
  }

  /** Writes the new phase, publishes `vote_updated` and sets the timer of the phase deadline. */
  private async persist(
    vote: LeaderVoteRow,
    next: VoteTransition,
    now: Date,
    extra: VoteSet,
    candidateUserId?: string,
  ): Promise<LeaderVoteRow> {
    const deadline = phaseDeadline(next, vote.openedAt, now);
    const closed = next.status === 'closed' || next.status === 'cancelled';
    const set: VoteSet = {
      ...extra,
      status: next.status,
      round: next.round,
      extended: next.extended,
      phaseDeadline: deadline,
      outcome: next.outcome,
      ...(closed ? { closedAt: now } : {}),
      ...(next.extended && !vote.extended && deadline !== null ? { votingDeadline: deadline } : {}),
    };
    await this.votes.updateVote(vote.id, set);
    const row: LeaderVoteRow = { ...vote, ...set } as LeaderVoteRow;
    await this.outbox.publish(this.updated(row, candidateUserId));
    await this.timers.scheduleDeadline({
      id: row.id,
      status: row.status,
      round: row.round,
      phaseDeadline: deadline,
    });
    return row;
  }

  private updated(vote: LeaderVoteRow, candidateUserId?: string) {
    return teamsEvent('vote_updated', vote.teamId, {
      teamId: vote.teamId,
      voteId: vote.id,
      status: vote.status,
      round: vote.round,
      ...(candidateUserId === undefined ? {} : { candidateUserId }),
    });
  }

  private async createOffer(
    vote: LeaderVoteRow,
    userId: string,
    kind: 'winner_confirmation' | 'senior_offer',
    now: Date,
  ): Promise<void> {
    const ordinal = (await this.votes.offersOf(vote.id)).length + 1;
    await this.votes.insertOffer({
      id: uuidv7(),
      voteId: vote.id,
      userId,
      kind,
      ordinal,
      status: 'offered',
      offeredAt: now,
      expiresAt: new Date(now.getTime() + OFFER_MS),
    });
  }

  /**
   * The candidates on the ballot with the votes that decide: `first` the round 1 tally, `runoff`
   * the round 2 tally of the runoff candidates, `confirm` the one that decides the winner.
   */
  private async scores(
    vote: LeaderVoteRow,
    mode: 'first' | 'runoff' | 'confirm',
  ): Promise<CandidateScore[]> {
    const candidates = (await this.votes.candidatesOf(vote.id)).filter(onBallot);
    const joined = new Map(
      (await this.votes.eligibleOf(vote.id)).map((e) => [e.userId, e.joinedAt] as const),
    );
    const memberships = new Map(
      (await this.votes.activeMembers(vote.teamId)).map((m) => [m.userId, m.membershipId] as const),
    );
    const counts = new Map(
      (await this.votes.tally(vote.id)).map((t) => [`${t.round}:${t.candidateUserId}`, t.n]),
    );
    const count = (round: number, userId: string) => counts.get(`${round}:${userId}`) ?? 0;
    return candidates
      .filter((c) => mode !== 'runoff' || c.inRunoff)
      .map((c) => ({
        userId: c.userId,
        joinedAt: joined.get(c.userId) ?? vote.openedAt,
        seniorityKey: memberships.get(c.userId) ?? '',
        inRunoff: c.inRunoff,
        votes:
          mode === 'first'
            ? count(1, c.userId)
            : mode === 'runoff' || (vote.round === 2 && c.inRunoff)
              ? count(2, c.userId)
              : count(1, c.userId),
      }));
  }

  /** Candidates still to be asked for the winner confirmation, in the order of asking. */
  private async confirmationPool(
    vote: LeaderVoteRow,
    preferred?: string,
  ): Promise<CandidateScore[]> {
    const asked = new Set(
      (await this.votes.offersOf(vote.id))
        .filter((o) => o.kind === 'winner_confirmation')
        .map((o) => o.userId),
    );
    const active = await this.activeIds(vote.teamId);
    const pool = (await this.scores(vote, 'confirm')).filter(
      (s) => !asked.has(s.userId) && active.has(s.userId),
    );
    const ordered = confirmationOrder(pool, vote.round === 2 ? 2 : 1);
    const chosen = ordered.find((s) => s.userId === preferred);
    return chosen === undefined ? ordered : [chosen, ...ordered.filter((s) => s !== chosen)];
  }

  /**
   * Active members not yet asked to lead, longest-serving first (FR-TEAM-20). Whoever already
   * refused the role in this vote (declined or let the confirmation expire, or withdrew) is not
   * asked again.
   */
  private async seniorPool(vote: LeaderVoteRow): Promise<string[]> {
    const offers = await this.votes.offersOf(vote.id);
    const refused = new Set(
      offers
        .filter((o) => o.kind === 'senior_offer' || o.status !== 'accepted')
        .map((o) => o.userId),
    );
    for (const c of await this.votes.candidatesOf(vote.id)) {
      if (c.withdrawnAt !== null) refused.add(c.userId);
    }
    const team = await this.teams.find(vote.teamId);
    return (await this.votes.activeMembers(vote.teamId))
      .map((m) => m.userId)
      .filter((id) => !refused.has(id) && id !== team?.leadUserId);
  }

  private async activeIds(teamId: string): Promise<Set<string>> {
    return new Set((await this.votes.activeMembers(teamId)).map((m) => m.userId));
  }

  private must(state: VoteState, event: VoteEvent): VoteTransition {
    const next = transition(state, event);
    if (next === undefined) {
      throw new InvariantError(`vote in ${state.status} does not accept ${event.type}`);
    }
    return next;
  }
}
