import { Inject, Injectable } from '@nestjs/common';
import { and, desc, eq, isNull, notInArray, sql } from 'drizzle-orm';
import { TxRunner } from '../../../../platform/tx/tx-runner.js';
import { membership } from '../schema/teams.js';
import {
  leaderVote,
  voteBallot,
  voteCandidate,
  voteEligible,
  voteOffer,
  voteRequest,
} from '../schema/votes.js';

export type LeaderVoteRow = typeof leaderVote.$inferSelect;
export type VoteEligibleRow = typeof voteEligible.$inferSelect;
export type VoteCandidateRow = typeof voteCandidate.$inferSelect;
export type VoteOfferRow = typeof voteOffer.$inferSelect;

export interface VoteCursor {
  openedAt: Date;
  id: string;
}

export interface MemberRow {
  userId: string;
  joinedAt: Date;
  trialUntil: Date | null;
  trialConfirmedAt: Date | null;
}

const CLOSED = ['closed', 'cancelled'];

/** `teams.leader_vote` and its satellites (architecture 5.5, 8). */
@Injectable()
export class LeaderVoteRepository {
  constructor(@Inject(TxRunner) private readonly tx: TxRunner) {}

  async insertVote(row: typeof leaderVote.$inferInsert): Promise<void> {
    await this.tx.tx.insert(leaderVote).values(row);
  }

  async updateVote(id: string, set: Partial<typeof leaderVote.$inferInsert>): Promise<void> {
    await this.tx.tx
      .update(leaderVote)
      .set({ ...set, version: sql`${leaderVote.version} + 1` })
      .where(eq(leaderVote.id, id));
  }

  async find(teamId: string, voteId: string): Promise<LeaderVoteRow | undefined> {
    const rows = await this.tx.tx
      .select()
      .from(leaderVote)
      .where(and(eq(leaderVote.id, voteId), eq(leaderVote.teamId, teamId)));
    return rows[0];
  }

  async findOpen(teamId: string): Promise<LeaderVoteRow | undefined> {
    const rows = await this.tx.tx
      .select()
      .from(leaderVote)
      .where(and(eq(leaderVote.teamId, teamId), notInArray(leaderVote.status, CLOSED)));
    return rows[0];
  }

  /** Newest first: the open vote is always the newest one. */
  list(teamId: string, after: VoteCursor | undefined, limit: number): Promise<LeaderVoteRow[]> {
    return this.tx.tx
      .select()
      .from(leaderVote)
      .where(
        and(
          eq(leaderVote.teamId, teamId),
          after === undefined
            ? undefined
            : sql`(${leaderVote.openedAt}, ${leaderVote.id}) < (${after.openedAt.toISOString()}::timestamptz, ${after.id}::uuid)`,
        ),
      )
      .orderBy(desc(leaderVote.openedAt), desc(leaderVote.id))
      .limit(limit);
  }

  /** Active members of the team with the data the eligibility snapshot needs. */
  activeMembers(teamId: string): Promise<MemberRow[]> {
    return this.tx.tx
      .select({
        userId: membership.userId,
        joinedAt: membership.joinedAt,
        trialUntil: membership.trialUntil,
        trialConfirmedAt: membership.trialConfirmedAt,
      })
      .from(membership)
      .where(and(eq(membership.teamId, teamId), eq(membership.status, 'active')))
      .orderBy(membership.joinedAt, membership.id);
  }

  async insertEligible(rows: (typeof voteEligible.$inferInsert)[]): Promise<void> {
    if (rows.length > 0) await this.tx.tx.insert(voteEligible).values(rows);
  }

  eligibleOf(voteId: string): Promise<VoteEligibleRow[]> {
    return this.tx.tx.select().from(voteEligible).where(eq(voteEligible.voteId, voteId));
  }

  async insertCandidate(row: typeof voteCandidate.$inferInsert): Promise<void> {
    await this.tx.tx.insert(voteCandidate).values(row);
  }

  async findCandidate(voteId: string, userId: string): Promise<VoteCandidateRow | undefined> {
    const rows = await this.tx.tx
      .select()
      .from(voteCandidate)
      .where(and(eq(voteCandidate.voteId, voteId), eq(voteCandidate.userId, userId)));
    return rows[0];
  }

  async updateCandidate(
    voteId: string,
    userId: string,
    set: Partial<typeof voteCandidate.$inferInsert>,
  ): Promise<void> {
    await this.tx.tx
      .update(voteCandidate)
      .set(set)
      .where(and(eq(voteCandidate.voteId, voteId), eq(voteCandidate.userId, userId)));
  }

  candidatesOf(voteId: string): Promise<VoteCandidateRow[]> {
    return this.tx.tx
      .select()
      .from(voteCandidate)
      .where(eq(voteCandidate.voteId, voteId))
      .orderBy(voteCandidate.consentAt, voteCandidate.userId);
  }

  async ballotsCast(voteId: string, round: number): Promise<number> {
    const rows = await this.tx.tx
      .select({ n: sql<number>`count(*)::int` })
      .from(voteBallot)
      .where(and(eq(voteBallot.voteId, voteId), eq(voteBallot.round, round)));
    return rows[0]?.n ?? 0;
  }

  async anyBallot(voteId: string): Promise<boolean> {
    const rows = await this.tx.tx
      .select({ n: sql<number>`count(*)::int` })
      .from(voteBallot)
      .where(eq(voteBallot.voteId, voteId));
    return (rows[0]?.n ?? 0) > 0;
  }

  async hasBallot(voteId: string, round: number, userId: string): Promise<boolean> {
    const rows = await this.tx.tx
      .select({ n: sql<number>`count(*)::int` })
      .from(voteBallot)
      .where(
        and(
          eq(voteBallot.voteId, voteId),
          eq(voteBallot.round, round),
          eq(voteBallot.voterUserId, userId),
        ),
      );
    return (rows[0]?.n ?? 0) > 0;
  }

  /** Counts per candidate and round. Never reveals who voted. */
  tally(voteId: string): Promise<{ candidateUserId: string; round: number; n: number }[]> {
    return this.tx.tx
      .select({
        candidateUserId: voteBallot.candidateUserId,
        round: voteBallot.round,
        n: sql<number>`count(*)::int`,
      })
      .from(voteBallot)
      .where(eq(voteBallot.voteId, voteId))
      .groupBy(voteBallot.candidateUserId, voteBallot.round);
  }

  async pendingOffer(voteId: string): Promise<VoteOfferRow | undefined> {
    const rows = await this.tx.tx
      .select()
      .from(voteOffer)
      .where(and(eq(voteOffer.voteId, voteId), eq(voteOffer.status, 'offered')));
    return rows[0];
  }

  /** Inactivity requests of members who are still active. */
  async requestCount(teamId: string): Promise<number> {
    const rows = await this.tx.tx
      .select({ n: sql<number>`count(*)::int` })
      .from(voteRequest)
      .innerJoin(
        membership,
        and(
          eq(membership.teamId, voteRequest.teamId),
          eq(membership.userId, voteRequest.userId),
          eq(membership.status, 'active'),
        ),
      )
      .where(eq(voteRequest.teamId, teamId));
    return rows[0]?.n ?? 0;
  }

  async insertRequest(teamId: string, userId: string, at: Date): Promise<void> {
    await this.tx.tx
      .insert(voteRequest)
      .values({ teamId, userId, createdAt: at })
      .onConflictDoNothing();
  }

  async clearRequests(teamId: string): Promise<void> {
    await this.tx.tx.delete(voteRequest).where(eq(voteRequest.teamId, teamId));
  }

  /** A candidate of this vote who has not been withdrawn yet (for departures of members). */
  async withdrawCandidateIfAny(voteId: string, userId: string, at: Date): Promise<void> {
    await this.tx.tx
      .update(voteCandidate)
      .set({ withdrawnAt: at })
      .where(
        and(
          eq(voteCandidate.voteId, voteId),
          eq(voteCandidate.userId, userId),
          isNull(voteCandidate.withdrawnAt),
        ),
      );
  }
}
