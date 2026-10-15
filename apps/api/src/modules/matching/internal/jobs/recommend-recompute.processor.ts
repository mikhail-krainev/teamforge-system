import { Inject, Injectable, type OnModuleInit } from '@nestjs/common';
import { type JobProcessor, ProcessorRegistry } from '../../../../platform/queues/queue-workers.js';
import type { QueueJob } from '../../../../platform/queues/queues.service.js';
import {
  RECOMPUTE_QUEUE,
  RECOMPUTE_SEAT_JOB,
  RECOMPUTE_TEAM_JOB,
  RECOMPUTE_USER_JOB,
} from '../services/recommend-scheduler.service.js';
import { ScoreRecomputeService } from '../services/score-recompute.service.js';

function idOf(job: QueueJob, key: string): string {
  const value = job.data[key];
  if (typeof value !== 'string') throw new Error(`${job.name} needs ${key}`);
  return value;
}

/**
 * Processor of the `matching-recompute` queue (architecture 6.3, 13.12): `recompute-seat`,
 * `recompute-team` and `recompute-user` fill `match_candidate`. Each job reads the state when it
 * runs, so the events of its window are not lost; a retry is harmless.
 */
@Injectable()
export class RecommendRecomputeProcessor implements JobProcessor, OnModuleInit {
  readonly queue = RECOMPUTE_QUEUE;

  constructor(
    @Inject(ProcessorRegistry) private readonly registry: ProcessorRegistry,
    @Inject(ScoreRecomputeService) private readonly recompute: ScoreRecomputeService,
  ) {}

  onModuleInit(): void {
    this.registry.register(this);
  }

  process(job: QueueJob): Promise<number> {
    switch (job.name) {
      case RECOMPUTE_SEAT_JOB:
        return this.recompute.recomputeSeat(idOf(job, 'seatId'));
      case RECOMPUTE_TEAM_JOB:
        return this.recompute.recomputeTeam(idOf(job, 'teamId'));
      case RECOMPUTE_USER_JOB:
        return this.recompute.recomputeUser(idOf(job, 'userId'));
      default:
        throw new Error(`Unknown matching-recompute job: ${job.name}`);
    }
  }
}
