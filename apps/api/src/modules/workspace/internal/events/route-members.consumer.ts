import { Inject, Injectable, type OnModuleInit } from '@nestjs/common';
import { EventConsumers } from '../../../../platform/outbox/event-consumers.js';
import type { EventConsumer, OutboxEventData } from '../../../../platform/outbox/outbox.types.js';
import { FallbackService } from '../services/fallback.service.js';

/**
 * Members leaving a team (architecture 11, FR-TEAM-11): their open items stay without an executor
 * and the fallback flags are recounted. `teams.member_joined` changes nothing on purpose: a role
 * that appears later is taken up by the lead with `revertFallback`, never by itself (FR-WORK-02).
 */
@Injectable()
export class RouteMembersConsumer implements EventConsumer, OnModuleInit {
  readonly consumer = 'workspace.route-members';
  readonly types = ['teams.member_left', 'teams.member_excluded'] as const;

  constructor(
    @Inject(EventConsumers) private readonly consumers: EventConsumers,
    @Inject(FallbackService) private readonly fallback: FallbackService,
  ) {}

  onModuleInit(): void {
    this.consumers.register(this);
  }

  async handle(event: OutboxEventData): Promise<void> {
    const { teamId, userId } = event.payload;
    if (typeof teamId !== 'string' || typeof userId !== 'string') return;
    await this.fallback.afterDeparture(teamId, userId);
  }
}
