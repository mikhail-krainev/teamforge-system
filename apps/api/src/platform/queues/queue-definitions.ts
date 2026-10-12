import type { JobsOptions } from 'bullmq';

export interface QueueDefinition {
  /** Worker concurrency (architecture 13.12). */
  concurrency: number;
  /** Total attempts including the first one. */
  attempts: number;
  /** Which Redis the queue lives in. `resume` is the separate redis-resume instance. */
  redis: 'main' | 'resume';
  /** `matching-*` queues re-enqueue time-windowed ids, so completed jobs must not be kept. */
  removeOnComplete: JobsOptions['removeOnComplete'];
}

const KEEP_24H = { age: 86_400 } as const;

/** Queue registry and retry policy (architecture 13.12, ADR-0012). */
export const QUEUE_DEFINITIONS = {
  events: { concurrency: 20, attempts: 5, redis: 'main', removeOnComplete: KEEP_24H },
  'resume-parse': { concurrency: 2, attempts: 2, redis: 'resume', removeOnComplete: KEEP_24H },
  'resume-dispatch': { concurrency: 2, attempts: 2, redis: 'main', removeOnComplete: KEEP_24H },
  'matching-recompute': { concurrency: 4, attempts: 5, redis: 'main', removeOnComplete: true },
  'matching-auto-add': { concurrency: 1, attempts: 5, redis: 'main', removeOnComplete: true },
  'github-webhook': { concurrency: 5, attempts: 5, redis: 'main', removeOnComplete: KEEP_24H },
  'github-sync': { concurrency: 5, attempts: 5, redis: 'main', removeOnComplete: KEEP_24H },
  'link-check': { concurrency: 5, attempts: 3, redis: 'main', removeOnComplete: KEEP_24H },
  'auto-checks': { concurrency: 5, attempts: 3, redis: 'main', removeOnComplete: KEEP_24H },
  timers: { concurrency: 5, attempts: 5, redis: 'main', removeOnComplete: KEEP_24H },
  maintenance: { concurrency: 1, attempts: 3, redis: 'main', removeOnComplete: KEEP_24H },
  notifications: { concurrency: 5, attempts: 5, redis: 'main', removeOnComplete: KEEP_24H },
} as const satisfies Record<string, QueueDefinition>;

export type QueueName = keyof typeof QUEUE_DEFINITIONS;

export const REMOVE_ON_FAIL = { age: 604_800 } as const;
export const BACKOFF_BASE_MS = 1_000;

/** Default job options for a queue: retries with exponential backoff, retention policy. */
export function defaultJobOptions(name: QueueName): JobsOptions {
  const definition: QueueDefinition = QUEUE_DEFINITIONS[name];
  return {
    attempts: definition.attempts,
    backoff: { type: 'exponential', delay: BACKOFF_BASE_MS },
    removeOnComplete: definition.removeOnComplete,
    removeOnFail: REMOVE_ON_FAIL,
  };
}
