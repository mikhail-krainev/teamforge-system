import { Inject, Injectable, type OnModuleInit } from '@nestjs/common';
import { EventConsumers } from '../../../../platform/outbox/event-consumers.js';
import type { EventConsumer, OutboxEventData } from '../../../../platform/outbox/outbox.types.js';
import { RecommendRepository } from '../repositories/recommend.repository.js';
import { type RecomputeKind, RecommendScheduler } from '../services/recommend-scheduler.service.js';

/** Events that change the recommendations (architecture 6.3, "Источники"). */
export const RECOMPUTE_TRIGGERS = [
  'teams.seat_opened',
  'teams.seat_closed',
  'teams.member_joined',
  'teams.member_left',
  'teams.member_excluded',
  'teams.team_status_changed',
  'matching.application_changed',
  'profiles.profile_updated',
] as const;

function text(event: OutboxEventData, key: string): string | undefined {
  const value = event.payload[key];
  return typeof value === 'string' ? value : undefined;
}

/**
 * `matching.recompute-triggers`: turns the events of teams, profiles and the queue into
 * `matching-recompute` jobs (deduplicated per target and 5 s window). A seat that closed or was
 * filled loses its rows right here, in the handler's transaction (architecture 6.3).
 */
@Injectable()
export class RecommendEventsConsumer implements EventConsumer, OnModuleInit {
  readonly consumer = 'matching.recompute-triggers';
  readonly types = RECOMPUTE_TRIGGERS;

  constructor(
    @Inject(EventConsumers) private readonly consumers: EventConsumers,
    @Inject(RecommendScheduler) private readonly scheduler: RecommendScheduler,
    @Inject(RecommendRepository) private readonly matches: RecommendRepository,
  ) {}

  onModuleInit(): void {
    this.consumers.register(this);
  }

  async handle(event: OutboxEventData): Promise<void> {
    const targets = await this.targets(event);
    for (const [kind, id] of targets) await this.scheduler.schedule(kind, id);
  }

  private async targets(event: OutboxEventData): Promise<[RecomputeKind, string][]> {
    const teamId = text(event, 'teamId');
    const seatId = text(event, 'seatId');
    const userId = text(event, 'userId');
    const pick = (...items: [RecomputeKind, string | undefined][]): [RecomputeKind, string][] =>
      items.flatMap(([kind, id]) =>
        id === undefined ? [] : [[kind, id] as [RecomputeKind, string]],
      );
    switch (`${event.module}.${event.type}`) {
      case 'teams.seat_opened':
        return pick(['seat', seatId]);
      case 'teams.seat_closed':
        if (seatId !== undefined) await this.matches.deleteBySeat(seatId);
        return [];
      case 'teams.member_joined':
        if (seatId !== undefined) await this.matches.deleteBySeat(seatId);
        return pick(['team', teamId], ['user', userId]);
      case 'teams.member_left':
      case 'teams.member_excluded':
        return pick(['team', teamId], ['user', userId]);
      case 'teams.team_status_changed':
        return pick(['team', teamId]);
      default:
        return pick(['user', userId]);
    }
  }
}
