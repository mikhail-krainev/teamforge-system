import { Inject, Injectable } from '@nestjs/common';
import { and, asc, eq, exists, inArray, lte, sql } from 'drizzle-orm';
import { TxRunner } from '../../../../platform/tx/tx-runner.js';
import { peerReview, reviewEligibility } from '../schema/profiles.js';

export type EligibilityRow = typeof reviewEligibility.$inferSelect;

/** SQL of `profiles.review_eligibility`: who may review whom and until when (FR-PROF-08). */
@Injectable()
export class ReviewEligibilityRepository {
  constructor(@Inject(TxRunner) private readonly tx: TxRunner) {}

  /** `ON CONFLICT DO NOTHING`: a repeated event or a scan adds nothing. Returns the rows really inserted. */
  async insertMany(rows: EligibilityRow[]): Promise<number> {
    if (rows.length === 0) return 0;
    const inserted = await this.tx.tx
      .insert(reviewEligibility)
      .values(rows)
      .onConflictDoNothing()
      .returning({ userId: reviewEligibility.userId });
    return inserted.length;
  }

  async find(teamId: string, userId: string): Promise<EligibilityRow | undefined> {
    const [row] = await this.tx.tx
      .select()
      .from(reviewEligibility)
      .where(and(eq(reviewEligibility.teamId, teamId), eq(reviewEligibility.userId, userId)));
    return row;
  }

  /**
   * The rows of the given people of a team under a shared lock: a publication of the team (which locks
   * the rows `FOR UPDATE`) waits for a review that is being written, and never misses it.
   */
  forShare(teamId: string, userIds: string[]): Promise<EligibilityRow[]> {
    return this.tx.tx
      .select()
      .from(reviewEligibility)
      .where(and(eq(reviewEligibility.teamId, teamId), inArray(reviewEligibility.userId, userIds)))
      .orderBy(asc(reviewEligibility.userId))
      .for('share');
  }

  /** All rows of a team, locked in a fixed order (by user id), so that parallel publications queue up. */
  lockTeam(teamId: string): Promise<EligibilityRow[]> {
    return this.tx.tx
      .select()
      .from(reviewEligibility)
      .where(eq(reviewEligibility.teamId, teamId))
      .orderBy(asc(reviewEligibility.userId))
      .for('update');
  }

  /** Of these teams, the ones that already have at least one row. */
  async teamsWithRows(teamIds: string[]): Promise<Set<string>> {
    if (teamIds.length === 0) return new Set();
    const rows = await this.tx.tx
      .selectDistinct({ teamId: reviewEligibility.teamId })
      .from(reviewEligibility)
      .where(inArray(reviewEligibility.teamId, teamIds));
    return new Set(rows.map((r) => r.teamId));
  }

  /**
   * Teams whose window is over and that still hold `pending` reviews (the sweep of the publication). M-5: it starts
   * from the pending reviews (`peer_review_pending_team_idx`, a set that empties as batches are published) and
   * looks up the window of each such team, so the growing history of `review_eligibility` is never read.
   */
  async dueTeams(now: Date): Promise<string[]> {
    const rows = await this.tx.tx
      .selectDistinct({ teamId: peerReview.teamId })
      .from(peerReview)
      .where(
        and(
          eq(peerReview.status, 'pending'),
          // `lte` on the column encodes the date; a raw `${now}` in `sql` reaches postgres-js as a Date and fails.
          exists(
            this.tx.tx
              .select({ one: sql`1` })
              .from(reviewEligibility)
              .where(
                and(
                  eq(reviewEligibility.teamId, peerReview.teamId),
                  lte(reviewEligibility.windowUntil, now),
                ),
              ),
          ),
        ),
      )
      .orderBy(asc(peerReview.teamId));
    return rows.map((r) => r.teamId);
  }

  async deleteForUser(userId: string): Promise<number> {
    const rows = await this.tx.tx
      .delete(reviewEligibility)
      .where(eq(reviewEligibility.userId, userId))
      .returning({ teamId: reviewEligibility.teamId });
    return rows.length;
  }
}
