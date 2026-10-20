import { Inject, Injectable } from '@nestjs/common';
import { and, eq, inArray, isNull } from 'drizzle-orm';
import { TxRunner } from '../../../../platform/tx/tx-runner.js';
import { artifactFile, reviewAnswer, reviewRisk } from '../schema/artifact.js';

/** Writes to `workspace.review_answer` and `workspace.review_risk` (architecture 5.7, lock level 9 is the item's version). */
@Injectable()
export class ReviewRepository {
  constructor(@Inject(TxRunner) private readonly tx: TxRunner) {}

  async fileUploaders(itemId: string): Promise<string[]> {
    const rows = await this.tx.tx
      .selectDistinct({ userId: artifactFile.uploadedBy })
      .from(artifactFile)
      .where(and(eq(artifactFile.checklistItemId, itemId), isNull(artifactFile.deletedAt)));
    return rows.map((r) => r.userId);
  }

  /** The last answer of a point wins (one row per point); a new answer withdraws an accepted risk. */
  async saveAnswers(
    itemId: string,
    reviewerId: string,
    answers: { ordinal: number; answer: boolean }[],
    now: Date,
  ): Promise<void> {
    for (const a of answers) {
      await this.tx.tx
        .insert(reviewAnswer)
        .values({
          checklistItemId: itemId,
          ordinal: a.ordinal,
          reviewerUserId: reviewerId,
          answer: a.answer,
          answeredAt: now,
        })
        .onConflictDoUpdate({
          target: [reviewAnswer.checklistItemId, reviewAnswer.ordinal],
          set: { reviewerUserId: reviewerId, answer: a.answer, answeredAt: now },
        });
    }
    await this.tx.tx.delete(reviewRisk).where(
      and(
        eq(reviewRisk.checklistItemId, itemId),
        inArray(
          reviewRisk.ordinal,
          answers.map((a) => a.ordinal),
        ),
      ),
    );
  }

  /** The artifact changed (a new link) or was reopened: the answers and the accepted risks no longer judge it. */
  async clear(itemId: string): Promise<void> {
    await this.tx.tx.delete(reviewAnswer).where(eq(reviewAnswer.checklistItemId, itemId));
    await this.tx.tx.delete(reviewRisk).where(eq(reviewRisk.checklistItemId, itemId));
  }

  async answersOf(itemId: string): Promise<{ ordinal: number; answer: boolean }[]> {
    return this.tx.tx
      .select({ ordinal: reviewAnswer.ordinal, answer: reviewAnswer.answer })
      .from(reviewAnswer)
      .where(eq(reviewAnswer.checklistItemId, itemId));
  }

  async risksOf(itemId: string): Promise<number[]> {
    const rows = await this.tx.tx
      .select({ ordinal: reviewRisk.ordinal })
      .from(reviewRisk)
      .where(eq(reviewRisk.checklistItemId, itemId));
    return rows.map((r) => r.ordinal);
  }

  async acceptRisk(
    itemId: string,
    ordinal: number,
    reason: string,
    leadId: string,
    now: Date,
  ): Promise<void> {
    await this.tx.tx
      .insert(reviewRisk)
      .values({ checklistItemId: itemId, ordinal, reason, acceptedBy: leadId, acceptedAt: now })
      .onConflictDoUpdate({
        target: [reviewRisk.checklistItemId, reviewRisk.ordinal],
        set: { reason, acceptedBy: leadId, acceptedAt: now },
      });
  }
}
