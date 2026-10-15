import { Inject, Injectable } from '@nestjs/common';
import { jobId } from '../../../../platform/queues/job-id.js';
import { QueuesService } from '../../../../platform/queues/queues.service.js';
import { AUTO_ADD_WINDOW_MS } from '../domain/auto-add-rules.js';

/** Queue of the auto-add (architecture 13.12); the scheduled and the event runs use the same job name. */
export const AUTO_ADD_QUEUE = 'matching-auto-add' as const;
export const AUTO_ADD_JOB = 'matching-auto-add';
/** Fixed key of the repeating job: two `worker` instances still make one schedule. */
export const AUTO_ADD_SCHEDULER_KEY = 'matching-auto-add-every-window';
/** An event-driven run waits this long, so that a series of events gives one run. */
export const AUTO_ADD_EVENT_DELAY_MS = 5_000;

/**
 * Puts an extra `matching-auto-add` run on the queue: `auto-add_<minute window>` with a 5 s delay
 * (architecture 6.4). Events of one window share the id and give one run; the queue drops completed
 * jobs, so the next window can add its own. Wall-clock time on purpose: the window is a scheduling
 * bucket, not business time.
 */
@Injectable()
export class AutoAddScheduler {
  constructor(@Inject(QueuesService) private readonly queues: QueuesService) {}

  async schedule(): Promise<void> {
    const window = Math.floor(Date.now() / AUTO_ADD_WINDOW_MS);
    await this.queues.add(
      AUTO_ADD_QUEUE,
      AUTO_ADD_JOB,
      {},
      { jobId: jobId('auto-add', window), delayMs: AUTO_ADD_EVENT_DELAY_MS },
    );
  }
}
