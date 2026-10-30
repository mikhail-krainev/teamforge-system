import { randomUUID } from 'node:crypto';
import type { Queue } from 'bullmq';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { InvalidJobIdError, jobId } from '../../src/platform/queues/job-id.js';
import { QueuesService } from '../../src/platform/queues/queues.service.js';
import { type TestApp, createTestApp, createTestWorker } from '../helpers/app.js';
import {
  createTestDatabase,
  describeInfra,
  type TestDatabase,
  uniqueQueuePrefix,
  waitFor,
} from '../helpers/infra.js';

describeInfra(
  'S1-07 BullMQ queues, deterministic jobId, example processor',
  ['db', 'redis'],
  () => {
    const prefix = uniqueQueuePrefix();
    let db: TestDatabase;
    let testApp: TestApp;
    let queues: QueuesService;

    beforeAll(async () => {
      db = await createTestDatabase();
      testApp = await createTestApp({ databaseUrl: db.url, queuePrefix: prefix });
      queues = testApp.app.get(QueuesService);
    });

    afterAll(async () => {
      await queues.getQueue('events').obliterate({ force: true });
      await queues.getQueue('maintenance').obliterate({ force: true });
      await testApp.close();
      await db.drop();
    });

    const counts = async (queue: Queue) => {
      const c = await queue.getJobCounts('waiting', 'delayed', 'active', 'completed', 'failed');
      return Object.values(c).reduce((a, b) => a + b, 0);
    };

    it('S1-07: adding the same jobId again does not create a second job', async () => {
      const id = jobId('dedupe', randomUUID());
      await queues.add('events', 'probe', { n: 1 }, { jobId: id });
      await queues.add('events', 'probe', { n: 2 }, { jobId: id });
      const job = await queues.getQueue('events').getJob(id);
      expect(job?.data).toMatchObject({ n: 1 });
      expect(await counts(queues.getQueue('events'))).toBe(1);
    });

    it('S1-07: 30 parallel adds with one jobId produce exactly one job', async () => {
      const id = jobId('parallel', randomUUID());
      await Promise.all(
        Array.from({ length: 30 }, (_, n) =>
          queues.add('maintenance', 'probe', { n }, { jobId: id }),
        ),
      );
      expect(await counts(queues.getQueue('maintenance'))).toBe(1);
    });

    it('rejects a jobId containing ":" or an integer id before reaching Redis', async () => {
      await expect(queues.add('events', 'probe', {}, { jobId: 'a:b' })).rejects.toBeInstanceOf(
        InvalidJobIdError,
      );
      await expect(queues.add('events', 'probe', {}, { jobId: '42' })).rejects.toBeInstanceOf(
        InvalidJobIdError,
      );
    });

    it('applies the retry and retention policy of architecture 13.12', async () => {
      const id = jobId('policy', randomUUID());
      await queues.add('events', 'probe', {}, { jobId: id });
      const job = await queues.getQueue('events').getJob(id);
      expect(job?.opts).toMatchObject({
        attempts: 5,
        backoff: { type: 'exponential', delay: 1000 },
        removeOnComplete: { age: 86_400 },
        removeOnFail: { age: 604_800 },
      });
    });

    it('S1-06/S1-07: the worker runs the example maintenance processor (idempotency-cleanup)', async () => {
      const worker = await createTestWorker({ databaseUrl: db.url, queuePrefix: prefix });
      try {
        await db.sql`INSERT INTO platform.idempotency_key
        (user_id, key, operation_id, request_hash, status, locked_until, lock_token, created_at, expires_at)
        VALUES (${randomUUID()}, ${randomUUID()}, 'x', ${Buffer.from('h')}, 'completed', now(), ${randomUUID()},
                now() - interval '2 days', now() - interval '1 day')`;
        const id = jobId('cleanup', randomUUID());
        await queues.add('maintenance', 'idempotency-cleanup', {}, { jobId: id });
        const job = await queues.getQueue('maintenance').getJob(id);
        await waitFor(async () => (await job?.isCompleted()) === true);
        const left = await db.sql`SELECT count(*)::int AS n FROM platform.idempotency_key`;
        expect(left[0]?.n).toBe(0);
        const schedulers = await queues.getQueue('maintenance').getJobSchedulers();
        // the platform's own tasks plus the ones modules register (slice 2: deletion, resume scan, orphan objects; slice 3: teams; slice 4: matching; slice 5: stage deadlines, link check sweep; slice 6: webhook sweeper and cleanup, daily sync, check of completion; slice 7: credit scan, due sweep and recheck, reviews)
        expect(schedulers.map((s) => s.key).sort()).toEqual([
          'completion-check-sweep',
          'credit-due-sweep',
          'credit-run-scan',
          'deletion-scheduler',
          'github-sync',
          'github-sync-resume',
          'idempotency-cleanup',
          'invitation-cleanup',
          'link-check-sweep',
          'matching-recompute-all',
          'max-duration-scan',
          'orphan-artifact-objects',
          'orphan-objects',
          'outbox-cleanup',
          'pending-account-recheck',
          'resume-stuck-scan',
          'review-eligibility-scan',
          'review-publish-sweep',
          'review-purge',
          'stage-due-notify',
          'vote-deadline-scan',
          'webhook-cleanup',
          'webhook-sweeper',
        ]);
      } finally {
        await worker.close();
      }
    });
  },
);
