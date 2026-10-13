import { Inject, Injectable } from '@nestjs/common';
import { and, eq, or, sql } from 'drizzle-orm';
import { DB, type Database } from '../../../../platform/db/db.module.js';
import type { TeamAccess } from '../authz/team-actor-policies.js';
import { membership, seatOffer, team } from '../schema/teams.js';
import { leaderVote, voteCandidate, voteEligible, voteOffer } from '../schema/votes.js';

/**
 * Reads behind the authorization policies. Every query takes the whole chain of identifiers
 * (team + nested id), so a nested id of another team is simply not found (architecture 13.14).
 * Runs outside a business transaction on the plain pool.
 */
@Injectable()
export class TeamAccessRepository implements TeamAccess {
  constructor(@Inject(DB) private readonly db: Database) {}

  async getTeamLead(teamId: string): Promise<{ leadUserId: string | null } | undefined> {
    const rows = await this.db
      .select({ leadUserId: team.leadUserId })
      .from(team)
      .where(eq(team.id, teamId));
    return rows[0];
  }

  async isActiveMember(teamId: string, userId: string): Promise<boolean> {
    const rows = await this.db
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
    return rows.length > 0;
  }

  async wasEverMember(teamId: string, userId: string): Promise<boolean> {
    const rows = await this.db
      .select({ id: membership.id })
      .from(membership)
      .where(and(eq(membership.teamId, teamId), eq(membership.userId, userId)))
      .limit(1);
    return rows.length > 0;
  }

  async getOfferParties(
    offerId: string,
  ): Promise<{ teamId: string; userId: string; leadUserId: string | null } | undefined> {
    const rows = await this.db
      .select({
        teamId: seatOffer.teamId,
        userId: seatOffer.userId,
        leadUserId: team.leadUserId,
      })
      .from(seatOffer)
      .innerJoin(team, eq(team.id, seatOffer.teamId))
      .where(eq(seatOffer.id, offerId));
    return rows[0];
  }

  async getVoteRole(
    teamId: string,
    voteId: string,
    userId: string,
  ): Promise<{ participant: boolean } | undefined> {
    const rows = await this.db
      .select({
        participant: sql<boolean>`(
          EXISTS (SELECT 1 FROM ${voteEligible} e WHERE e.vote_id = ${leaderVote.id} AND e.user_id = ${userId})
          OR EXISTS (SELECT 1 FROM ${voteCandidate} c WHERE c.vote_id = ${leaderVote.id} AND c.user_id = ${userId})
          OR EXISTS (SELECT 1 FROM ${voteOffer} o WHERE o.vote_id = ${leaderVote.id} AND o.user_id = ${userId})
        )`,
      })
      .from(leaderVote)
      .where(
        and(
          eq(leaderVote.id, voteId),
          eq(leaderVote.teamId, teamId),
          or(
            sql`EXISTS (SELECT 1 FROM ${membership} m WHERE m.team_id = ${teamId} AND m.user_id = ${userId} AND m.status = 'active')`,
            sql`EXISTS (SELECT 1 FROM ${voteOffer} o2 WHERE o2.vote_id = ${leaderVote.id} AND o2.user_id = ${userId})`,
          ),
        ),
      );
    return rows[0];
  }
}
