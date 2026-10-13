import { Inject, Injectable, type OnModuleInit } from '@nestjs/common';
import { eq } from 'drizzle-orm';
import { APP_CONFIG } from '../../../../platform/config/config.module.js';
import type { AppConfig } from '../../../../platform/config/config.js';
import { MailService } from '../../../../platform/mail/mail.service.js';
import { EventConsumers } from '../../../../platform/outbox/event-consumers.js';
import type { EventConsumer, OutboxEventData } from '../../../../platform/outbox/outbox.types.js';
import { TxRunner } from '../../../../platform/tx/tx-runner.js';
import { user } from '../schema/auth.js';
import { deletionRequestedMessage } from './deletion-mail.js';
import { cancelTokenFor, DELETION_REQUEST_CREATED } from './deletion-notice.js';
import { DeletionRepository } from './deletion.repository.js';

/**
 * Sends the "deletion requested" mail with the cancel link after the request has committed
 * (S2CR-02). Re-reads the state: a request that was cancelled or has already started its saga gets
 * no mail. A redelivery after a crash may queue a second identical mail (at-least-once), which is
 * harmless: both links carry the same token.
 */
@Injectable()
export class DeletionMailConsumer implements EventConsumer, OnModuleInit {
  readonly consumer = 'auth.deletion-mail';
  readonly types = [DELETION_REQUEST_CREATED];

  constructor(
    @Inject(EventConsumers) private readonly consumers: EventConsumers,
    @Inject(DeletionRepository) private readonly repository: DeletionRepository,
    @Inject(TxRunner) private readonly tx: TxRunner,
    @Inject(MailService) private readonly mail: MailService,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  onModuleInit(): void {
    this.consumers.register(this);
  }

  async handle(event: OutboxEventData): Promise<void> {
    const { requestId, userId } = event.payload as { requestId: string; userId: string };
    const request = await this.repository.findById(requestId);
    if (request?.status !== 'requested') return;
    const rows = await this.tx.tx
      .select({ email: user.email })
      .from(user)
      .where(eq(user.id, userId));
    const email = rows[0]?.email ?? null;
    if (email === null) return;
    const token = cancelTokenFor(this.config.IP_HASH_SALT, requestId);
    const link = `${this.config.APP_ORIGIN}/deletion/cancel#token=${token}`;
    await this.mail.enqueue(deletionRequestedMessage(email, link, request.scheduledAt));
  }
}
