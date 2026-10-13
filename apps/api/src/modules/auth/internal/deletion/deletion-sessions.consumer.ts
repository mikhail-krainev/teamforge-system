import { Inject, Injectable, type OnModuleInit } from '@nestjs/common';
import { EventConsumers } from '../../../../platform/outbox/event-consumers.js';
import type { EventConsumer, OutboxEventData } from '../../../../platform/outbox/outbox.types.js';
import { SessionRevoker } from '../services/session-revoker.js';
import { DELETION_REQUEST_CREATED } from './deletion-notice.js';
import { DeletionRepository } from './deletion.repository.js';

/**
 * Revokes every session of the account whose deletion was requested (S2CR-02). Revoking is
 * idempotent (a second run finds no sessions), and a Redis failure makes the event retry instead of
 * leaving live sessions behind a committed request. A request cancelled in the meantime keeps its
 * sessions.
 */
@Injectable()
export class DeletionSessionsConsumer implements EventConsumer, OnModuleInit {
  readonly consumer = 'auth.deletion-sessions';
  readonly types = [DELETION_REQUEST_CREATED];

  constructor(
    @Inject(EventConsumers) private readonly consumers: EventConsumers,
    @Inject(DeletionRepository) private readonly repository: DeletionRepository,
    @Inject(SessionRevoker) private readonly sessions: SessionRevoker,
  ) {}

  onModuleInit(): void {
    this.consumers.register(this);
  }

  async handle(event: OutboxEventData): Promise<void> {
    const { requestId, userId } = event.payload as { requestId: string; userId: string };
    const request = await this.repository.findById(requestId);
    if (request === undefined) return;
    if (request.status !== 'requested' && request.status !== 'in_progress') return;
    await this.sessions.revokeUserSessions(userId);
  }
}
