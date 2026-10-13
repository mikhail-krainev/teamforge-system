import { Inject, Injectable, type OnModuleInit } from '@nestjs/common';
import { eq } from 'drizzle-orm';
import { EventConsumers } from '../../../../platform/outbox/event-consumers.js';
import type { EventConsumer, OutboxEventData } from '../../../../platform/outbox/outbox.types.js';
import { TxRunner } from '../../../../platform/tx/tx-runner.js';
import { AUTH_API, type AuthApi, USER_DELETION_REQUESTED } from '../../../auth/public.js';
import { profile, resumeUpload } from '../schema/profiles.js';
import { ResumeStorage } from '../resume/resume-storage.js';

/**
 * The `profiles` step of the deletion saga (architecture 13.9): profile with roles, stack and
 * experience, every resume (rows, extracted text, files in storage). Idempotent: a second delivery
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
    });
  }
}
