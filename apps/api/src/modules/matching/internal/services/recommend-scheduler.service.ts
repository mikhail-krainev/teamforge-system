import { Inject, Injectable } from '@nestjs/common';
import { jobId } from '../../../../platform/queues/job-id.js';
import { QueuesService } from '../../../../platform/queues/queues.service.js';

/** Queue of the recomputation (architecture 13.12) and its job names. */
export const RECOMPUTE_QUEUE = 'matching-recompute' as const;
export const RECOMPUTE_SEAT_JOB = 'recompute-seat';
export const RECOMPUTE_TEAM_JOB = 'recompute-team';
export const RECOMPUTE_USER_JOB = 'recompute-user';
export type RecomputeKind = 'seat' | 'team' | 'user';

/** The delay and the dedup window of a recompute, 5 s (architecture 6.3). */
export const RECOMPUTE_WINDOW_MS = 5_000;

const JOB_NAMES: Record<RecomputeKind, string> = {
  seat: RECOMPUTE_SEAT_JOB,
  team: RECOMPUTE_TEAM_JOB,
  user: RECOMPUTE_USER_JOB,
};

/**
 * Puts recompute jobs on the `matching-recompute` queue with `recompute_<kind>_<id>_<bucket>`
 * (bucket = floor(now / 5 s)) and a 5 s delay: a series of events in one window gives one job, and
 * an event during the run gets the id of the next window. Wall-clock time on purpose: the bucket is
 * a scheduling window, not business time.
 */
@Injectable()
export class RecommendScheduler {
  constructor(@Inject(QueuesService) private readonly queues: QueuesService) {}

  async schedule(kind: RecomputeKind, id: string): Promise<void> {
    const bucket = Math.floor(Date.now() / RECOMPUTE_WINDOW_MS);
    await this.queues.add(
      RECOMPUTE_QUEUE,
      JOB_NAMES[kind],
      { [`${kind}Id`]: id },
      { jobId: jobId('recompute', kind, id, bucket), delayMs: RECOMPUTE_WINDOW_MS },
    );
  }
}
