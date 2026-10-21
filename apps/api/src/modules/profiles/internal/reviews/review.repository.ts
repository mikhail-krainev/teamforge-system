import { Inject, Injectable } from '@nestjs/common';
import { and, eq, lte, sql } from 'drizzle-orm';
import { TxRunner } from '../../../../platform/tx/tx-runner.js';
import { peerReview } from '../schema/profiles.js';
import { MIN_REVIEW_AUTHORS, WITHHELD_RETENTION_DAYS } from './review-rules.js';

export interface NewReview {
  id: string;
  teamId: string;
  subjectUserId: string;
  text: string;
  sortKey: number;
}

/** What the publication did to one subject of a team. */
export interface SettledSubject {
  subjectUserId: string;
  status: 'published' | 'withheld';
  reviews: number;
}

/** SQL of `profiles.peer_review` for writing, publishing, purging and erasing (the reading side is `ReceivedReviewsQuery`). */
@Injectable()
export class ReviewRepository {
  constructor(@Inject(TxRunner) private readonly tx: TxRunner) {}

  async insertPending(review: NewReview): Promise<void> {
    await this.tx.tx.insert(peerReview).values({ ...review, status: 'pending' });
  }

  /**
   * One statement for the whole team: a subject with at least two `pending` reviews gets them published on
   * `day` (the day the window closed, the same for the batch), any other gets them withheld until `day` + 30.
   */
  async settleTeam(teamId: string, day: string): Promise<SettledSubject[]> {
    const rows = await this.tx.tx.execute<{
      subject_user_id: string;
      status: 'published' | 'withheld';
      reviews: number;
    }>(sql`
      WITH pending AS (
        SELECT subject_user_id, count(*)::int AS n
          FROM profiles.peer_review
         WHERE team_id = ${teamId}::uuid AND status = 'pending'
         GROUP BY subject_user_id
      ), settled AS (
        UPDATE profiles.peer_review r
           SET status = CASE WHEN p.n >= ${MIN_REVIEW_AUTHORS} THEN 'published' ELSE 'withheld' END,
               published_on = CASE WHEN p.n >= ${MIN_REVIEW_AUTHORS} THEN ${day}::date END,
               purge_after = CASE WHEN p.n >= ${MIN_REVIEW_AUTHORS} THEN NULL
                                  ELSE ${day}::date + ${WITHHELD_RETENTION_DAYS}::int END
          FROM pending p
         WHERE r.team_id = ${teamId}::uuid AND r.status = 'pending'
           AND r.subject_user_id = p.subject_user_id
        RETURNING r.subject_user_id, r.status
      )
      SELECT subject_user_id, status, count(*)::int AS reviews
        FROM settled GROUP BY subject_user_id, status ORDER BY subject_user_id`);
    return [...rows].map((r) => ({
      subjectUserId: r.subject_user_id,
      status: r.status,
      reviews: r.reviews,
    }));
  }

  /** Deletes the withheld reviews whose day has come; their authorship rows go by `ON DELETE CASCADE`. */
  async purgeDue(today: string): Promise<number> {
    const rows = await this.tx.tx
      .delete(peerReview)
      .where(and(eq(peerReview.status, 'withheld'), lte(peerReview.purgeAfter, today)))
      .returning({ id: peerReview.id });
    return rows.length;
  }

  /** FR-AUTH-09: the reviews about an erased person (with their authorship rows, by cascade). */
  async deleteAbout(subjectUserId: string): Promise<number> {
    const rows = await this.tx.tx
      .delete(peerReview)
      .where(eq(peerReview.subjectUserId, subjectUserId))
      .returning({ id: peerReview.id });
    return rows.length;
  }
}
