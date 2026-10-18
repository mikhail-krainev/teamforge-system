import { DelayedError, UnrecoverableError, Worker } from 'bullmq';
import type { Redis } from 'ioredis';
import { type LinkCheckResult, LINK_CHECK_QUEUE, linkCheckJobSchema } from './protocol.js';
import { normalizeHostname } from './host.js';
import {
  DomainBusy,
  TOTAL_TIMEOUT_MS,
  type CheckOptions,
  type LinkCheckOutcome,
} from './ssrf-client.js';

/** C-46: at most one check per domain per minute. */
export const DOMAIN_INTERVAL_MS = 60_000;
const DEFAULT_CONCURRENCY = 5;
/** The lock of a job outlasts the deadline of a check, or a slow check would be taken for a stalled one. */
const LOCK_MARGIN_MS = 30_000;
/** A job that keeps meeting a busy domain is given up this long after the first busy answer: a `TIMEOUT`, a warning only. */
const MAX_THROTTLE_AGE_MS = 10 * 60_000;

export interface LinkCheckWorkerOptions {
  connection: Redis;
  /** BullMQ key prefix (`QUEUE_PREFIX`); the ACL user of this process reaches `<prefix>:link-check:*` only. */
  prefix: string;
  checker: { check(url: string, options?: CheckOptions): Promise<LinkCheckOutcome> };
  concurrency?: number;
  domainIntervalMs?: number;
  /** How long a check may keep meeting a busy domain, counted from the first time it did. */
  maxThrottleMs?: number;
  /** The deadline of one check; the lock of a job is longer. */
  totalTimeoutMs?: number;
  onError?(error: Error): void;
}

/**
 * The consumer of the `link-check` queue. It checks the address of a job and returns the answer as the
 * job result; the `worker` process applies it. No database or object store is touched here. The
 * per-domain pause is a key inside this queue's own namespace, so the Redis ACL needs nothing more.
 */
export function startLinkCheckWorker(
  options: LinkCheckWorkerOptions,
): Worker<unknown, LinkCheckResult> {
  const interval = options.domainIntervalMs ?? DOMAIN_INTERVAL_MS;
  const maxThrottleMs = options.maxThrottleMs ?? MAX_THROTTLE_AGE_MS;

  /** Milliseconds to wait before this domain may be checked again, 0 when it may be checked now. */
  async function pauseFor(rawHostname: string): Promise<number> {
    const hostname = normalizeHostname(rawHostname) ?? rawHostname;
    const key = `${options.prefix}:${LINK_CHECK_QUEUE}:domain:${hostname}`;
    if (interval <= 0) return 0;
    const taken = await options.connection.set(key, '1', 'PX', interval, 'NX');
    if (taken === 'OK') return 0;
    return Math.max(1_000, await options.connection.pttl(key));
  }

  const worker = new Worker<unknown, LinkCheckResult>(
    LINK_CHECK_QUEUE,
    async (job, token) => {
      const parsed = linkCheckJobSchema.safeParse(job.data);
      if (!parsed.success) throw new UnrecoverableError('malformed link-check job');
      const { teamId, itemId, version, url } = parsed.data;
      const hostname = hostnameOf(url);
      const wait = hostname === undefined ? 0 : await pauseFor(hostname);
      if (wait > 0) {
        await job.moveToDelayed(Date.now() + wait, token);
        throw new DelayedError();
      }
      try {
        const outcome = await options.checker.check(url, { throttle: pauseFor });
        return { teamId, itemId, version, url, outcome };
      } catch (error) {
        if (!(error instanceof DomainBusy)) throw error;
        const firstBusyAt = parsed.data.firstBusyAt ?? Date.now();
        if (Date.now() - firstBusyAt > maxThrottleMs) {
          const outcome: LinkCheckOutcome = { ok: false, reason: 'TIMEOUT', httpStatus: null };
          return { teamId, itemId, version, url, outcome };
        }
        if (parsed.data.firstBusyAt === undefined) {
          await job.updateData({ ...parsed.data, firstBusyAt });
        }
        await job.moveToDelayed(Date.now() + Math.max(1_000, error.waitMs), token);
        throw new DelayedError();
      }
    },
    {
      connection: options.connection,
      prefix: options.prefix,
      concurrency: options.concurrency ?? DEFAULT_CONCURRENCY,
      lockDuration: (options.totalTimeoutMs ?? TOTAL_TIMEOUT_MS) + LOCK_MARGIN_MS,
    },
  );
  worker.on('error', (error) => options.onError?.(error));
  return worker;
}

function hostnameOf(url: string): string | undefined {
  try {
    return normalizeHostname(new URL(url).hostname);
  } catch {
    return undefined;
  }
}
