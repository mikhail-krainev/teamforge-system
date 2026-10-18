import { randomUUID } from 'node:crypto';
import { Queue, QueueEvents, type Worker } from 'bullmq';
import { Redis } from 'ioredis';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { describeInfra, uniqueQueuePrefix } from '../../test/helpers/infra.js';
import { startLinkCheckWorker } from './link-check-worker.js';
import {
  CHECK_ITEM_LINK_JOB,
  linkCheckJobId,
  LINK_CHECK_QUEUE,
  type LinkCheckResult,
} from './protocol.js';
import {
  createLinkChecker,
  DomainBusy,
  TOTAL_TIMEOUT_MS,
  type CheckOptions,
  type LinkCheckOutcome,
} from './ssrf-client.js';

/*
 * The consumer of the `link-check` queue (S5-09): result of a check as the job result, the per-domain
 * pause (C-46), a malformed job fails for good, and the whole thing works under the narrow Redis ACL
 * of the `linkcheck` user, which sees only `bull:link-check:*`.
 */

const LINKCHECK_URL =
  process.env.REDIS_LINKCHECK_URL ?? 'redis://linkcheck:tf_test_redis_linkcheck@127.0.0.1:6380';
const OK: LinkCheckOutcome = { ok: true, reason: null, httpStatus: 200 };

type LinkCheckerLike = {
  check(url: string, options?: CheckOptions): Promise<LinkCheckOutcome>;
};

interface Harness {
  queue: Queue;
  events: QueueEvents;
  worker: Worker;
  seen: string[];
  close(): Promise<void>;
}

function startHarness(options: {
  prefix: string;
  redisUrl: string;
  outcome?: (url: string) => LinkCheckOutcome;
  domainIntervalMs?: number;
  busyOnce?: boolean;
  alwaysBusy?: boolean;
  maxThrottleMs?: number;
  checker?: LinkCheckerLike;
}): Harness {
  const seen: string[] = [];
  const consumer = new Redis(options.redisUrl, { maxRetriesPerRequest: null });
  const producer = new Redis(process.env.REDIS_URL ?? '', { maxRetriesPerRequest: null });
  const queue = new Queue(LINK_CHECK_QUEUE, { connection: producer, prefix: options.prefix });
  const events = new QueueEvents(LINK_CHECK_QUEUE, {
    connection: producer.duplicate(),
    prefix: options.prefix,
  });
  const worker = startLinkCheckWorker({
    connection: consumer,
    prefix: options.prefix,
    domainIntervalMs: options.domainIntervalMs ?? 0,
    ...(options.maxThrottleMs === undefined ? {} : { maxThrottleMs: options.maxThrottleMs }),
    checker: options.checker ?? {
      check: (url) => {
        seen.push(url);
        if (options.alwaysBusy === true) return Promise.reject(new DomainBusy(200));
        if (options.busyOnce === true && seen.length === 1)
          return Promise.reject(new DomainBusy(300));
        return Promise.resolve(options.outcome ? options.outcome(url) : OK);
      },
    },
  });
  return {
    queue,
    events,
    worker,
    seen,
    async close() {
      await worker.close();
      await events.close();
      await queue.close();
      producer.disconnect();
      consumer.disconnect();
    },
  };
}

const jobData = (url: string) => ({
  teamId: randomUUID(),
  itemId: randomUUID(),
  version: 3,
  url,
});

async function run(
  h: Harness,
  url: string,
  data = jobData(url),
  extra: { timestamp?: number } = {},
): Promise<LinkCheckResult> {
  const job = await h.queue.add(CHECK_ITEM_LINK_JOB, data, {
    jobId: linkCheckJobId(data.itemId, data.version),
    attempts: 1,
    ...extra,
  });
  return (await job.waitUntilFinished(h.events, 15_000)) as LinkCheckResult;
}

describeInfra('link-checker: consumer of the link-check queue (S5-09)', ['redis'], () => {
  const prefix = uniqueQueuePrefix();
  let h: Harness;

  beforeAll(async () => {
    h = startHarness({
      prefix,
      redisUrl: process.env.REDIS_URL ?? '',
      outcome: (url) =>
        url.includes('broken')
          ? { ok: false, reason: 'HTTP_STATUS', httpStatus: 404 }
          : url.includes('internal')
            ? { ok: false, reason: 'BLOCKED_ADDRESS', httpStatus: null }
            : OK,
    });
    await h.events.waitUntilReady();
  });

  afterAll(async () => {
    if (h) await h.close();
  });

  it('the answer of the checker is the job result, together with the ids it belongs to', async () => {
    const data = jobData('https://example.test/ok');
    expect(await run(h, data.url, data)).toEqual({ ...data, outcome: OK });
  });

  it('failures come back as codes, never as text', async () => {
    const broken = await run(h, 'https://example.test/broken');
    expect(broken.outcome).toEqual({ ok: false, reason: 'HTTP_STATUS', httpStatus: 404 });
    const internal = await run(h, 'https://example.test/internal');
    expect(internal.outcome).toEqual({ ok: false, reason: 'BLOCKED_ADDRESS', httpStatus: null });
  });

  it('a malformed job fails at once and is never checked', async () => {
    const seenBefore = h.seen.length;
    const job = await h.queue.add(
      CHECK_ITEM_LINK_JOB,
      { teamId: 'not-a-uuid', url: 'https://example.test/x' },
      { attempts: 3 },
    );
    await expect(job.waitUntilFinished(h.events, 15_000)).rejects.toThrow(/malformed/);
    expect(h.seen.length).toBe(seenBefore);
    expect((await h.queue.getJob(job.id ?? ''))?.attemptsMade).toBe(1);
  });
});

describeInfra('link-checker: Redis ACL and the pause per domain (C-46)', ['redis'], () => {
  // The ACL of the `linkcheck` user names `bull:link-check:*`, so this run uses the production prefix.
  let h: Harness;
  const unique = randomUUID().slice(0, 8);

  beforeAll(async () => {
    h = startHarness({ prefix: 'bull', redisUrl: LINKCHECK_URL, domainIntervalMs: 1_500 });
    await h.events.waitUntilReady();
  });

  afterAll(async () => {
    if (h) await h.close();
  });

  it('works with the narrow ACL; a second check of the same domain waits, another domain does not', async () => {
    const started = Date.now();
    const first = await run(h, `https://${unique}.example.test/one`);
    const other = await run(h, `https://other-${unique}.example.test/one`);
    expect([first.outcome.ok, other.outcome.ok]).toEqual([true, true]);
    expect(Date.now() - started).toBeLessThan(1_000);
    const second = await run(h, `https://${unique}.example.test/two`);
    expect(second.outcome.ok).toBe(true);
    expect(Date.now() - started).toBeGreaterThanOrEqual(1_000);
  }, 30_000);
});

describeInfra(
  'link-checker: a busy redirect domain and the lock of a long check',
  ['redis'],
  () => {
    const prefix = uniqueQueuePrefix();
    let h: Harness;

    beforeAll(async () => {
      h = startHarness({ prefix, redisUrl: process.env.REDIS_URL ?? '', busyOnce: true });
      await h.events.waitUntilReady();
    });

    afterAll(async () => {
      if (h) await h.close();
    });

    it('a check that meets a busy domain on a redirect is delayed and run again, not failed', async () => {
      const result = await run(h, 'https://example.test/redirecting');
      expect(result.outcome).toEqual(OK);
      expect(h.seen).toHaveLength(2);
    });

    it('the age of a job counts from its first busy domain, not from its creation', async () => {
      const hourAgo = Date.now() - 60 * 60_000;
      const data = jobData('https://example.test/old-job');
      // `busyOnce` is spent by the previous test, so a fresh harness gives the first call the busy answer.
      const fresh = startHarness({
        prefix: uniqueQueuePrefix(),
        redisUrl: process.env.REDIS_URL ?? '',
        busyOnce: true,
      });
      try {
        await fresh.events.waitUntilReady();
        const result = await run(fresh, data.url, data, { timestamp: hourAgo });
        expect(result.outcome).toEqual(OK);
        expect(fresh.seen).toHaveLength(2);
      } finally {
        await fresh.close();
      }
    });

    it('a domain that stays busy ends as a TIMEOUT once the limit counted from the first busy answer passes', async () => {
      const fresh = startHarness({
        prefix: uniqueQueuePrefix(),
        redisUrl: process.env.REDIS_URL ?? '',
        alwaysBusy: true,
        maxThrottleMs: 1_500,
      });
      try {
        await fresh.events.waitUntilReady();
        const result = await run(fresh, 'https://example.test/always-busy');
        expect(result.outcome).toEqual({ ok: false, reason: 'TIMEOUT', httpStatus: null });
        expect(fresh.seen.length).toBeGreaterThan(1);
      } finally {
        await fresh.close();
      }
    }, 30_000);

    it('the lock of a job outlasts the deadline of a check, so a slow check is not taken for a stalled one', () => {
      expect(h.worker.opts.lockDuration).toBeGreaterThan(TOTAL_TIMEOUT_MS);
    });
  },
);

describeInfra('link-checker: a redirect to the same host, with the real checker and Redis', ['redis'], () => {
  const prefix = uniqueQueuePrefix();
  let h: Harness;
  const unique = randomUUID().slice(0, 8);
  const requested: string[] = [];

  beforeAll(async () => {
    const checker = createLinkChecker({
      resolve: () => Promise.resolve(['93.184.216.34']),
      request: (hop) => {
        requested.push(`${hop.host}${hop.path}`);
        return Promise.resolve(
          hop.path === '/start'
            ? { status: 302, location: `https://${hop.host}/final` }
            : { status: 200 },
        );
      },
    });
    h = startHarness({
      prefix,
      redisUrl: process.env.REDIS_URL ?? '',
      domainIntervalMs: 60_000,
      checker,
    });
    await h.events.waitUntilReady();
  });

  afterAll(async () => {
    if (h) await h.close();
  });

  it('a redirect to the host of the first hop is not told to wait for its own slot', async () => {
    const host = `${unique}.example.test`;
    const result = await run(h, `https://${host}/start`);
    expect(result.outcome).toEqual(OK);
    expect(requested).toEqual([`${host}/start`, `${host}/final`]);
  }, 20_000);
});

describeInfra('link-checker: one spelling of a host for the pause', ['redis'], () => {
  const prefix = uniqueQueuePrefix();
  let h: Harness;
  const unique = randomUUID().slice(0, 8);

  beforeAll(async () => {
    h = startHarness({ prefix, redisUrl: process.env.REDIS_URL ?? '', domainIntervalMs: 1_500 });
    await h.events.waitUntilReady();
  });

  afterAll(async () => {
    if (h) await h.close();
  });

  it('a trailing dot and capitals do not give a second slot to the same domain', async () => {
    const started = Date.now();
    await run(h, `https://${unique}.example.test/one`);
    await run(h, `https://${unique.toUpperCase()}.Example.test./two`);
    expect(Date.now() - started).toBeGreaterThanOrEqual(1_000);
  }, 30_000);
});

describe('link-checker module', () => {
  it('has no database or storage code in its imports', async () => {
    const { readdirSync, readFileSync } = await import('node:fs');
    const { fileURLToPath } = await import('node:url');
    const dir = fileURLToPath(new URL('.', import.meta.url));
    const files = readdirSync(dir).filter((f) => f.endsWith('.ts') && !f.endsWith('.test.ts'));
    for (const file of files) {
      const text = readFileSync(`${dir}/${file}`, 'utf8');
      expect(text, file).not.toMatch(/from '(\.\.\/)+(platform|modules)\//);
      expect(text, file).not.toMatch(/drizzle|postgres|@aws-sdk/);
    }
  });
});
