import { Worker } from 'bullmq';
import { Redis } from 'ioredis';

/**
 * Result of the isolated parser (architecture 13.15): the only thing resume-worker returns.
 * Reasons are the ones the contract of the slice knows about after the application maps them.
 */
export type ParseResult =
  | { v: 1; ok: true; text: string; pages: number }
  | {
      v: 1;
      ok: false;
      reason: 'NO_TEXT' | 'TIMEOUT' | 'LIMIT' | 'ENCRYPTED' | 'CORRUPTED' | 'UNSUPPORTED';
    }
  | Record<string, unknown>;

export interface FakeResumeWorker {
  /** What the next jobs answer; the default is a successful parse of `DEFAULT_RESUME_TEXT`. */
  respondWith(result: ParseResult | ((uploadId: string) => ParseResult)): void;
  /** Upload ids of the jobs seen so far, in order. */
  seen: string[];
  close(): Promise<void>;
}

export const DEFAULT_RESUME_TEXT =
  'Ivan Petrov. Backend developer. TypeScript, PostgreSQL, Redis. 2024-2026 Teamforge.';

/**
 * Stands in for the `resume-worker` container in API tests: consumes the `resume-parse` queue of the
 * isolated `redis-resume` instance and returns a canned parser result. The real isolation (uid
 * 10002, limits) is checked in the container's own tests and in the Playwright scenario.
 *
 * `redisUrl` needs the `resume` ACL user (`REDIS_RESUME_CONSUMER_URL`; the default matches
 * docker-compose.test.yml); `prefix` is the QUEUE_PREFIX of the application under test.
 */
export function startFakeResumeWorker(prefix: string, redisUrl?: string): FakeResumeWorker {
  const url =
    redisUrl ??
    process.env.REDIS_RESUME_CONSUMER_URL ??
    'redis://resume:tf_test_resume@127.0.0.1:6381';
  const connection = new Redis(url, { maxRetriesPerRequest: null });
  const seen: string[] = [];
  let answer: ParseResult | ((uploadId: string) => ParseResult) = {
    v: 1,
    ok: true,
    text: DEFAULT_RESUME_TEXT,
    pages: 1,
  };
  const worker = new Worker(
    'resume-parse',
    (job) => {
      const uploadId = String(job.data?.uploadId ?? job.id ?? '').replace(/^parse_/, '');
      seen.push(uploadId);
      return Promise.resolve(typeof answer === 'function' ? answer(uploadId) : answer);
    },
    { connection, prefix, concurrency: 2 },
  );
  worker.on('error', () => undefined);
  return {
    respondWith(result) {
      answer = result;
    },
    seen,
    async close() {
      await worker.close();
      connection.disconnect();
    },
  };
}
