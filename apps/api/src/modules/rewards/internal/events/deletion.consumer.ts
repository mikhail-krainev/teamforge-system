import { Inject, Injectable, type OnModuleInit } from '@nestjs/common';
import { eq, sql } from 'drizzle-orm';
import { EventConsumers } from '../../../../platform/outbox/event-consumers.js';
import type { EventConsumer, OutboxEventData } from '../../../../platform/outbox/outbox.types.js';
import { TxRunner } from '../../../../platform/tx/tx-runner.js';
import { AUTH_API, type AuthApi, USER_DELETION_REQUESTED } from '../../../auth/public.js';
import { award, counter, credit, dispute, fraudSignal, projectCredit } from '../schema/rewards.js';

/**
 * The `rewards` step of the deletion saga (architecture 13.9, 152-FZ): the awards, counters, credits and
 * disputes of the person are deleted, and his id is struck out of the `data` of the signals of the anti-fraud
 * (AF-15, AF-16 name members). The journal of the administrator (AF-25) stays: it holds the administrator's
 * decisions, not the data of the people they were about. Idempotent.
 */
@Injectable()
export class RewardsDeletionConsumer implements EventConsumer, OnModuleInit {
  readonly consumer = 'rewards.user-deletion';
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
    const awards = await db
      .delete(award)
      .where(eq(award.userId, userId))
      .returning({ id: award.id });
    await db.delete(counter).where(eq(counter.userId, userId));
    const roles = await db
      .delete(credit)
      .where(eq(credit.userId, userId))
      .returning({ r: credit.roleCode });
    const projects = await db
      .delete(projectCredit)
      .where(eq(projectCredit.userId, userId))
      .returning({ t: projectCredit.teamId });
    const disputes = await db
      .delete(dispute)
      .where(eq(dispute.userId, userId))
      .returning({ id: dispute.id });
    const signals = await db
      .update(fraudSignal)
      .set({ data: sql`replace(${fraudSignal.data}::text, ${userId}, 'deleted')::jsonb` })
      .where(sql`${fraudSignal.data}::text LIKE ${`%${userId}%`}`)
      .returning({ id: fraudSignal.id });
    await this.auth.reportDeletionStep(requestId, 'rewards', {
      awards: awards.length,
      credits: roles.length + projects.length,
      disputes: disputes.length,
      signals: signals.length,
    });
  }
}
