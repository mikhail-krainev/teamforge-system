import { Inject, Injectable } from '@nestjs/common';
import { and, asc, eq } from 'drizzle-orm';
import { TxRunner } from '../../../../platform/tx/tx-runner.js';
import { peerReviewAuthorship } from '../schema/profiles.js';

/**
 * The only door to `peer_review_authorship` (SEC-04, architecture 5.3): the pair of an author and a
 * subject lives here, apart from the text. It serves `createPeerReview`, `listSentReviews` and the
 * deletion saga; the code that shows reviews to a subject must never import it.
 */
@Injectable()
export class ReviewAuthorshipRepository {
  constructor(@Inject(TxRunner) private readonly tx: TxRunner) {}

  /** `false` when the pair already has a review: the unique index `peer_review_pair_uq` decides a race. */
  async insertIfAbsent(row: {
    reviewId: string;
    teamId: string;
    authorUserId: string;
    subjectUserId: string;
  }): Promise<boolean> {
    const inserted = await this.tx.tx
      .insert(peerReviewAuthorship)
      .values(row)
      .onConflictDoNothing()
      .returning({ reviewId: peerReviewAuthorship.reviewId });
    return inserted.length > 0;
  }

  async subjectsOf(teamId: string, authorUserId: string): Promise<string[]> {
    const rows = await this.tx.tx
      .select({ subjectUserId: peerReviewAuthorship.subjectUserId })
      .from(peerReviewAuthorship)
      .where(
        and(
          eq(peerReviewAuthorship.teamId, teamId),
          eq(peerReviewAuthorship.authorUserId, authorUserId),
        ),
      )
      .orderBy(asc(peerReviewAuthorship.subjectUserId));
    return rows.map((r) => r.subjectUserId);
  }

  /** Р-20: the reviews of an erased author stay with their subjects, only the link to him goes. */
  async deleteByAuthor(authorUserId: string): Promise<number> {
    const rows = await this.tx.tx
      .delete(peerReviewAuthorship)
      .where(eq(peerReviewAuthorship.authorUserId, authorUserId))
      .returning({ reviewId: peerReviewAuthorship.reviewId });
    return rows.length;
  }
}
