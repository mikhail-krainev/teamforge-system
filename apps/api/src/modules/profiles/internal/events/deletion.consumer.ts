import { Inject, Injectable, type OnModuleInit } from '@nestjs/common';
import { eq } from 'drizzle-orm';
import { EventConsumers } from '../../../../platform/outbox/event-consumers.js';
import type { EventConsumer, OutboxEventData } from '../../../../platform/outbox/outbox.types.js';
import { TxRunner } from '../../../../platform/tx/tx-runner.js';
import { AUTH_API, type AuthApi, USER_DELETION_REQUESTED } from '../../../auth/public.js';
import { profile, resumeUpload } from '../schema/profiles.js';
import { ReviewAuthorshipRepository } from '../reviews/review-authorship.repository.js';
import { ReviewEligibilityRepository } from '../reviews/review-eligibility.repository.js';
import { ReviewRepository } from '../reviews/review.repository.js';
import { ResumeStorage } from '../resume/resume-storage.js';

/**
 * The `profiles` step of the deletion saga (architecture 13.9): profile with roles, stack and
 * experience, every resume (rows, extracted text, files in storage), the peer reviews (S7-07). Idempotent: a second delivery
 * finds nothing and reports the same counts of zero (the inbox stops it earlier anyway).
 */
@Injectable()
export class ProfilesDeletionConsumer implements EventConsumer, OnModuleInit {
  readonly consumer = 'profiles.user-deletion';
  readonly types = [USER_DELETION_REQUESTED];

  constructor(
    @Inject(EventConsumers) private readonly consumers: EventConsumers,
    @Inject(TxRunner) private readonly tx: TxRunner,
    @Inject(ResumeStorage) private readonly storage: ResumeStorage,
    @Inject(AUTH_API) private readonly auth: AuthApi,
    @Inject(ReviewRepository) private readonly reviews: ReviewRepository,
    @Inject(ReviewAuthorshipRepository) private readonly authorship: ReviewAuthorshipRepository,
    @Inject(ReviewEligibilityRepository) private readonly eligibility: ReviewEligibilityRepository,
  ) {}

  onModuleInit(): void {
    this.consumers.register(this);
  }

  async handle(event: OutboxEventData): Promise<void> {
    const { requestId, userId } = event.payload as { requestId: string; userId: string };
    const db = this.tx.tx;
    const uploads = await db
      .select({ key: resumeUpload.storageKey })
      .from(resumeUpload)
      .where(eq(resumeUpload.userId, userId));
    // Files first: if storage fails the event is retried and the rows still point at the objects.
    for (const { key } of uploads) await this.storage.removeStrict(key);
    await db.delete(resumeUpload).where(eq(resumeUpload.userId, userId));
    // Roles, stack and experience go with the profile (ON DELETE CASCADE).
    const profiles = await db
      .delete(profile)
      .where(eq(profile.userId, userId))
      .returning({ id: profile.userId });
    await this.auth.reportDeletionStep(requestId, 'profiles', {
      profiles: profiles.length,
      resumes: uploads.length,
      ...(await this.eraseReviews(userId)),
    });
  }
  /**
   * Р-20, SEC-04: the reviews about the person go (their authorship rows by cascade), his own right to
   * write goes, and so does the link to him as an author; the texts he wrote stay with their subjects.
   */
  private async eraseReviews(userId: string): Promise<Record<string, number>> {
    return {
      reviewsAbout: await this.reviews.deleteAbout(userId),
      reviewAuthorships: await this.authorship.deleteByAuthor(userId),
      reviewWindows: await this.eligibility.deleteForUser(userId),
    };
  }
}
