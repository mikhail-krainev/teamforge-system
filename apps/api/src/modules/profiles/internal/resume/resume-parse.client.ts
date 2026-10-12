import { Inject, Injectable, type OnApplicationShutdown } from '@nestjs/common';
import { QueueEvents } from 'bullmq';
import type { Redis } from 'ioredis';
import { APP_CONFIG } from '../../../../platform/config/config.module.js';
import type { AppConfig } from '../../../../platform/config/config.js';
import { InvariantError } from '../../../../platform/errors/domain-error.js';
import { QueuesService } from '../../../../platform/queues/queues.service.js';
import { REDIS_RESUME_BULL } from '../../../../platform/redis/redis.module.js';
import { type ParseResult, parseResultSchema } from './parse-result.js';

const WAIT_MS = 30_000;
const FAILED_KEEP_SECONDS = 3600;

const corrupted: ParseResult = { v: 1, ok: false, reason: 'CORRUPTED' };
const timedOut: ParseResult = { v: 1, ok: false, reason: 'TIMEOUT' };

/** Everything that is not exactly the agreed shape counts as a corrupted file. */
function checked(value: unknown): ParseResult {
  const raw = typeof value === 'string' ? safeJson(value) : value;
  const parsed = parseResultSchema.safeParse(raw);
  return parsed.success ? parsed.data : corrupted;
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

/**
 * The worker's side of the isolated parser (architecture 13.15): puts the bytes of one file into the
 * `resume-parse` queue of `redis-resume`, waits for the answer (30 s) and checks it against the strict
 * schema. The job holds the upload id, the type and the bytes only: no user id, no URL, no secret.
 */
@Injectable()
export class ResumeParseClient implements OnApplicationShutdown {
  private events: QueueEvents | undefined;

  constructor(
    @Inject(QueuesService) private readonly queues: QueuesService,
    @Inject(REDIS_RESUME_BULL) private readonly connection: Redis | null,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  /** One long-lived listener, so that a fast answer cannot slip by between `add` and the wait. */
  private async listener(): Promise<QueueEvents> {
    if (this.events !== undefined) return this.events;
    if (this.connection === null) throw new InvariantError('REDIS_RESUME_URL is not configured');
    const events = new QueueEvents('resume-parse', {
      connection: this.connection.duplicate(),
      prefix: this.config.QUEUE_PREFIX,
    });
    events.on('error', () => undefined);
    await events.waitUntilReady();
    this.events = events;
    return events;
  }

  async parse(uploadId: string, mime: string, bytes: Buffer): Promise<ParseResult> {
    const events = await this.listener();
    const queue = this.queues.getQueue('resume-parse');
    const jobId = `parse_${uploadId}`;
    await (await queue.getJob(jobId))?.remove().catch(() => undefined);
    const answer = this.answerOf(events, jobId);
    try {
      await queue.add(
        'parse',
        { uploadId, mime, data: bytes.toString('base64') },
        { jobId, attempts: 1, removeOnComplete: true, removeOnFail: { age: FAILED_KEEP_SECONDS } },
      );
    } catch (error) {
      answer.cancel();
      throw error;
    }
    const outcome = await answer.result;
    await (await queue.getJob(jobId))?.remove().catch(() => undefined);
    return outcome;
  }

  private answerOf(
    events: QueueEvents,
    jobId: string,
  ): { result: Promise<ParseResult>; cancel(): void } {
    let cancel = (): void => undefined;
    const result = new Promise<ParseResult>((resolve) => {
      const finish = (value: ParseResult): void => {
        clearTimeout(timer);
        events.off('completed', onCompleted);
        events.off('failed', onFailed);
        resolve(value);
      };
      const onCompleted = (event: { jobId: string; returnvalue: unknown }): void => {
        if (event.jobId === jobId) finish(checked(event.returnvalue));
      };
      const onFailed = (event: { jobId: string }): void => {
        if (event.jobId === jobId) finish(corrupted);
      };
      const timer = setTimeout(() => finish(timedOut), WAIT_MS);
      events.on('completed', onCompleted);
      events.on('failed', onFailed);
      cancel = () => finish(corrupted);
    });
    return { result, cancel: () => cancel() };
  }

  async onApplicationShutdown(): Promise<void> {
    await this.events?.close();
  }
}
