import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import type { Redis } from 'ioredis';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { EventConsumers } from '../../src/platform/outbox/event-consumers.js';
import { OutboxService } from '../../src/platform/outbox/outbox.service.js';
import { REDIS_BULL } from '../../src/platform/redis/redis.module.js';
import { QueuesService } from '../../src/platform/queues/queues.service.js';
import { TxRunner } from '../../src/platform/tx/tx-runner.js';
import { createTestWorker } from '../helpers/app.js';
import {
  createTestDatabase,
  describeInfra,
  scanKeys,
  type TestDatabase,
  uniqueQueuePrefix,
  waitFor,
} from '../helpers/infra.js';

/** Database errors carry SQL and bound parameters; BullMQ keeps failedReason/stack in Redis for 7 days. */
describeInfra(
  'S1 follow-up: database errors are cleaned before they leave a job processor',
  ['db', 'redis'],
  () => {
    const prefix = uniqueQueuePrefix();
    const secretEmail = `secret-${randomUUID()}@example.test`;
    const secretToken = `tok-${randomUUID()}`;
    let db: TestDatabase;
    let worker: Awaited<ReturnType<typeof createTestWorker>>;

    beforeAll(async () => {
      db = await createTestDatabase();
      worker = await createTestWorker({ databaseUrl: db.url, queuePrefix: prefix });
      await db.sql`INSERT INTO public.tf_test_account (email, token) VALUES (${secretEmail}, 'first')`;
      worker.context.get(EventConsumers).register({
        consumer: 'leaky-consumer',
        types: ['platform.leak'],
        handle: async () => {
          // A real unique violation with the secrets as bound parameters.
          // Inside the consumer's transaction: through the transaction client, as every consumer does.
          await worker.context
            .get(TxRunner)
            .tx.execute(
              sql`INSERT INTO public.tf_test_account (email, token) VALUES (${secretEmail}, ${secretToken})`,
            );
        },
      });
    });

    afterAll(async () => {
      const queues = worker.context.get(QueuesService);
      await queues.getQueue('events').obliterate({ force: true });
      await worker.close();
      await db.drop();
    });

    it('stores no SQL parameter values in failedReason, stack or anywhere in the job hash', async () => {
      const queues = worker.context.get(QueuesService);
      await worker.context.get(TxRunner).run(() =>
        worker.context.get(OutboxService).publish({
          module: 'platform',
          type: 'leak',
          aggregateId: randomUUID(),
          payload: { n: 1 },
        }),
      );
      const queue = queues.getQueue('events');
      const failed = await waitFor(async () => {
        const jobs = await queue.getJobs(['delayed', 'failed', 'waiting', 'active']);
        return jobs.find((job) => job.failedReason !== undefined && job.failedReason !== '');
      }, 20_000);
      expect(failed.failedReason).toContain('database query failed');
      expect(failed.failedReason).toContain('23505');
      const text = JSON.stringify([failed.failedReason, failed.stacktrace]);
      for (const secret of [secretEmail, secretToken, 'INSERT INTO', 'tf_test_account']) {
        expect(text).not.toContain(secret);
      }
      // Everything BullMQ keeps for this queue, as stored in Redis.
      const redis = worker.context.get<Redis>(REDIS_BULL);
      const keys = await scanKeys(redis, `${prefix}:events:*`);
      for (const key of keys) {
        if ((await redis.type(key)) !== 'hash') continue;
        const stored = JSON.stringify(await redis.hgetall(key));
        expect(stored).not.toContain(secretEmail);
        expect(stored).not.toContain(secretToken);
      }
    });
  },
);
