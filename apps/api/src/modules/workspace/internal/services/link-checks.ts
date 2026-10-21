import { Inject, Injectable } from '@nestjs/common';
import {
  CHECK_ITEM_LINK_JOB,
  LINK_CHECK_QUEUE,
  type LinkCheckJobData,
  type LinkCheckResult,
  linkCheckResultSchema,
} from '../../../../link-checker/protocol.js';
import { QueuesService } from '../../../../platform/queues/queues.service.js';

export type LinkOutcome = LinkCheckResult['outcome'];

export interface LinkCheckJob {
  jobId: string;
  data: Omit<LinkCheckJobData, 'requestId' | 'firstBusyAt'>;
}

/** The link-checker is slow on purpose (one look per domain per minute, up to ten minutes of waiting). */
export const LINK_CHECKS_WAIT_MS = 11 * 60_000;
const POLL_MS = 200;

const TIMED_OUT: LinkOutcome = { ok: false, reason: 'TIMEOUT', httpStatus: null };
const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Asks the `link-checker` process about addresses through the `link-check` queue and waits for the answers
 * (the application never opens a student's address itself, SEC-05). A job id that exists already is not queued
 * again, so a retried job of the completion check reads the answers the first attempt asked for.
 */
@Injectable()
export class LinkChecks {
  constructor(@Inject(QueuesService) private readonly queues: QueuesService) {}

  /** One outcome per job, in the order of the jobs; an answer that did not come in time is a `TIMEOUT`. */
  async run(jobs: LinkCheckJob[], waitMs = LINK_CHECKS_WAIT_MS): Promise<LinkOutcome[]> {
    for (const job of jobs) {
      await this.queues.add(LINK_CHECK_QUEUE, CHECK_ITEM_LINK_JOB, job.data, { jobId: job.jobId });
    }
    const outcomes = new Map<string, LinkOutcome>();
    const deadline = Date.now() + waitMs;
    while (outcomes.size < jobs.length && Date.now() < deadline) {
      for (const job of jobs) {
        if (outcomes.has(job.jobId)) continue;
        const outcome = await this.outcomeOf(job.jobId);
        if (outcome !== undefined) outcomes.set(job.jobId, outcome);
      }
      if (outcomes.size < jobs.length) await sleep(POLL_MS);
    }
    return jobs.map((job) => outcomes.get(job.jobId) ?? TIMED_OUT);
  }

  private async outcomeOf(id: string): Promise<LinkOutcome | undefined> {
    const queue = this.queues.getQueue(LINK_CHECK_QUEUE);
    // The state first, the job after it: a job read while it was running has no return value yet.
    const state = await queue.getJobState(id);
    if (state === 'failed') return TIMED_OUT;
    if (state !== 'completed') return undefined;
    const finished = await queue.getJob(id);
    const parsed = linkCheckResultSchema.safeParse(finished?.returnvalue);
    return parsed.success ? parsed.data.outcome : TIMED_OUT;
  }
}
