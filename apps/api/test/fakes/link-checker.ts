import { Worker } from 'bullmq';
import { Redis } from 'ioredis';
import { startLinkCheckWorker } from '../../src/link-checker/link-check-worker.js';
import type { LinkCheckOutcome } from '../../src/link-checker/ssrf-client.js';

export const OK_OUTCOME: LinkCheckOutcome = { ok: true, reason: null, httpStatus: 200 };

export interface FakeLinkChecker {
  /** What the checker answers for an address; the default is a plain 200. */
  respondWith(answer: (url: string) => LinkCheckOutcome): void;
  /** Addresses seen so far, in order. */
  seen: string[];
  /** While paused, jobs stay in the queue (a checker that is down). */
  pause(): Promise<void>;
  resume(): void;
  close(): Promise<void>;
}

/**
 * Stands in for the `link-checker` container in API tests: the real consumer of the `link-check` queue
 * (`startLinkCheckWorker`) with a canned checker instead of the network. `prefix` is the QUEUE_PREFIX of
 * the application under test; no pause per domain, so tests may check one host many times.
 */
export function startFakeLinkChecker(prefix: string): FakeLinkChecker {
  const connection = new Redis(process.env.REDIS_URL ?? '', { maxRetriesPerRequest: null });
  const seen: string[] = [];
  let answer: (url: string) => LinkCheckOutcome = () => OK_OUTCOME;
  const start = (): Worker =>
    startLinkCheckWorker({
      connection,
      prefix,
      domainIntervalMs: 0,
      checker: {
        check: (url) => {
          seen.push(url);
          return Promise.resolve(answer(url));
        },
      },
    });
  let worker: Worker | undefined = start();
  return {
    respondWith(next) {
      answer = next;
    },
    seen,
    async pause() {
      await worker?.close();
      worker = undefined;
    },
    resume() {
      worker ??= start();
    },
    async close() {
      await worker?.close();
      connection.disconnect();
    },
  };
}
