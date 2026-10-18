import { DelayedError, type Job, UnrecoverableError, Worker } from 'bullmq';
import type { Redis } from 'ioredis';
import {
  type LinkCheckJobData,
  type LinkCheckResult,
  LINK_CHECK_QUEUE,
  linkCheckJobSchema,
} from './protocol.js';
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
const SLOT_ATTEMPTS = 3;
const MIN_DELAY_MS = 1_000;
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

  /**
   * Milliseconds to wait before this domain may be checked again, 0 when it may be checked now. The slot
   * is `SET key owner NX PX`: a job that comes back after a delay finds its own slot and keeps it, so a
   * check that waited for the host of a redirect is not blocked by the slot it took for the first host.
   */
  async function pauseFor(rawHostname: string, owner: string): Promise<number> {
    const hostname = normalizeHostname(rawHostname) ?? rawHostname;
    const key = `${options.prefix}:${LINK_CHECK_QUEUE}:domain:${hostname}`;
    if (interval <= 0) return 0;
    for (let attempt = 0; attempt < SLOT_ATTEMPTS; attempt += 1) {
      const taken = await options.connection.set(key, owner, 'PX', interval, 'NX');
      if (taken === 'OK') return 0;
      const holder = await options.connection.get(key);
      if (holder === owner) return 0;
      // The slot expired between the two commands: take it on the next round.
      if (holder !== null) return Math.max(1_000, await options.connection.pttl(key));
    }
    return 1_000;
  }

  const worker = new Worker<unknown, LinkCheckResult>(
    LINK_CHECK_QUEUE,
    async (job, token) => {
      const parsed = linkCheckJobSchema.safeParse(job.data);
      if (!parsed.success) throw new UnrecoverableError('malformed link-check job');
      const { teamId, itemId, version, url } = parsed.data;
      const owner = job.id ?? `${itemId}_${version}`;
      const timedOutResult = (): LinkCheckResult => ({
        teamId,
        itemId,
        version,
        url,
        outcome: { ok: false, reason: 'TIMEOUT', httpStatus: null },
      });
      const hostname = hostnameOf(url);
      const wait = hostname === undefined ? 0 : await pauseFor(hostname, owner);
      if (wait > 0) {
        // The first host is held by another check: the same limit on waiting as for a redirect host.
        await deferBusyJob(job, token, parsed.data, wait, maxThrottleMs);
        return timedOutResult();
      }
      try {
        const outcome = await options.checker.check(url, {
          throttle: (host) => pauseFor(host, owner),
        });
        return { teamId, itemId, version, url, outcome };
      } catch (error) {
        if (!(error instanceof DomainBusy)) throw error;
        await deferBusyJob(job, token, parsed.data, error.waitMs, maxThrottleMs);
        return timedOutResult();
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

/**
 * A check met a busy domain: moves the job and throws `DelayedError`, or just returns when the time allowed
 * for waiting (counted from the first busy answer, kept in the job data) has run out.
 */
async function deferBusyJob(
  job: Job,
  token: string | undefined,
  data: LinkCheckJobData,
  waitMs: number,
  maxThrottleMs: number,
): Promise<void> {
  const firstBusyAt = data.firstBusyAt ?? Date.now();
  const age = Date.now() - firstBusyAt;
  if (age > maxThrottleMs) return;
  if (data.firstBusyAt === undefined) await job.updateData({ ...data, firstBusyAt });
  // Never sleep past the limit, so the last look at the domain happens right after it.
  const delay = Math.min(
    Math.max(MIN_DELAY_MS, waitMs),
    Math.max(MIN_DELAY_MS, maxThrottleMs - age + 1),
  );
  await job.moveToDelayed(Date.now() + delay, token);
  throw new DelayedError();
}

function hostnameOf(url: string): string | undefined {
  try {
    return normalizeHostname(new URL(url).hostname);
  } catch {
    return undefined;
  }
}
