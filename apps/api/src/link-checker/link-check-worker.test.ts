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
import type { LinkCheckOutcome } from './ssrf-client.js';

/*
 * The consumer of the `link-check` queue (S5-09): result of a check as the job result, the per-domain
 * pause (C-46), a malformed job fails for good, and the whole thing works under the narrow Redis ACL
 * of the `linkcheck` user, which sees only `bull:link-check:*`.
 */

const LINKCHECK_URL =
  process.env.REDIS_LINKCHECK_URL ?? 'redis://linkcheck:tf_test_redis_linkcheck@127.0.0.1:6380';
const OK: LinkCheckOutcome = { ok: true, reason: null, httpStatus: 200 };

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
    checker: {
      check: (url) => {
        seen.push(url);
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

async function run(h: Harness, url: string, data = jobData(url)): Promise<LinkCheckResult> {
  const job = await h.queue.add(CHECK_ITEM_LINK_JOB, data, {
    jobId: linkCheckJobId(data.itemId, data.version),
    attempts: 1,
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
