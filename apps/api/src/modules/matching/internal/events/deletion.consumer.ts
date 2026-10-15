import { Inject, Injectable, type OnModuleInit } from '@nestjs/common';
import { eq } from 'drizzle-orm';
import { EventConsumers } from '../../../../platform/outbox/event-consumers.js';
import type { EventConsumer, OutboxEventData } from '../../../../platform/outbox/outbox.types.js';
import { TxRunner } from '../../../../platform/tx/tx-runner.js';
import { AUTH_API, type AuthApi, USER_DELETION_REQUESTED } from '../../../auth/public.js';
import { candidateStats, matchCandidate, searchApplication } from '../schema/matching.js';

/**
 * The `matching` step of the deletion saga (architecture 13.9): the person's applications (roles and
 * exclusions go with them, ON DELETE CASCADE), precomputed recommendations and statistics. The
 * closed waits (`wait_sample`) and the auto-add journal hold application ids only, no user id, and
 * stay. Idempotent: a second delivery finds nothing and reports zeros.
 */
@Injectable()
export class MatchingDeletionConsumer implements EventConsumer, OnModuleInit {
  readonly consumer = 'matching.user-deletion';
  readonly types = [USER_DELETION_REQUESTED];

  constructor(
    @Inject(EventConsumers) private readonly consumers: EventConsumers,
    @Inject(TxRunner) private readonly tx: TxRunner,
    @Inject(AUTH_API) private readonly auth: AuthApi,
  ) {}

  onModuleInit(): void {
    this.consumers.register(this);
  }

  async handle(event: OutboxEventData): Promise<void> {
    const { requestId, userId } = event.payload as { requestId: string; userId: string };
    const db = this.tx.tx;
    const applications = await db
      .delete(searchApplication)
      .where(eq(searchApplication.userId, userId))
      .returning({ id: searchApplication.id });
    const candidates = await db
      .delete(matchCandidate)
      .where(eq(matchCandidate.userId, userId))
      .returning({ seatId: matchCandidate.seatId });
    const stats = await db
      .delete(candidateStats)
      .where(eq(candidateStats.userId, userId))
      .returning({ roleCode: candidateStats.roleCode });
    await this.auth.reportDeletionStep(requestId, 'matching', {
      applications: applications.length,
      recommendations: candidates.length,
      stats: stats.length,
    });
  }
}
