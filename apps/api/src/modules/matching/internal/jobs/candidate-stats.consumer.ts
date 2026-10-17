import { Inject, Injectable, type OnModuleInit } from '@nestjs/common';
import { EventConsumers } from '../../../../platform/outbox/event-consumers.js';
import type { EventConsumer, OutboxEventData } from '../../../../platform/outbox/outbox.types.js';
import { CandidateStatsRepository } from '../repositories/candidate-stats.repository.js';
import { RecommendScheduler } from '../services/recommend-scheduler.service.js';

/** Completed projects per role from `counters` of the event; anything else is ignored. */
export function completedCounters(counters: unknown): Map<string, number> {
  const result = new Map<string, number>();
  if (typeof counters !== 'object' || counters === null || Array.isArray(counters)) return result;
  for (const [roleCode, count] of Object.entries(counters)) {
    if (typeof count === 'number' && Number.isInteger(count) && count >= 0) {
      result.set(roleCode, count);
    }
  }
  return result;
}

/**
 * `matching.candidate-stats`: projection of `rewards.credits_changed {userId, roleCodes, counters}`
 * into `candidate_stats` (architecture 3.5, FR-MATCH-12 component C-44e), then a recompute of the
 * person's recommendations. `counters` is read as `{ [roleCode]: completed projects }` and replaces
 * the stored numbers (the event is at-least-once, so a counter is set, not added).
 */
@Injectable()
export class CandidateStatsConsumer implements EventConsumer, OnModuleInit {
  readonly consumer = 'matching.candidate-stats';
  readonly types = ['rewards.credits_changed'] as const;

  constructor(
    @Inject(EventConsumers) private readonly consumers: EventConsumers,
    @Inject(CandidateStatsRepository) private readonly stats: CandidateStatsRepository,
    @Inject(RecommendScheduler) private readonly scheduler: RecommendScheduler,
  ) {}

  onModuleInit(): void {
    this.consumers.register(this);
  }

  async handle(event: OutboxEventData): Promise<void> {
    const userId = event.payload['userId'];
    if (typeof userId !== 'string') return;
    await this.stats.setCounters(userId, completedCounters(event.payload['counters']));
    await this.scheduler.schedule('user', userId);
  }
}
