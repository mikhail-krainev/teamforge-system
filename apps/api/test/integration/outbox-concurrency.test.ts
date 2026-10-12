import { randomUUID } from 'node:crypto';
import type { INestApplicationContext } from '@nestjs/common';
import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import { EventConsumers } from '../../src/platform/outbox/event-consumers.js';
import { OutboxRelayLoop } from '../../src/platform/outbox/outbox-relay-loop.js';
import { OutboxRelay } from '../../src/platform/outbox/outbox-relay.js';
import { OUTBOX_BATCH } from '../../src/platform/outbox/outbox.types.js';
import { jobId } from '../../src/platform/queues/job-id.js';
import { QueuesService } from '../../src/platform/queues/queues.service.js';
import { createTestWorker } from '../helpers/app.js';
import { createTestDatabase, describeInfra, type TestDatabase, waitFor } from '../helpers/infra.js';

describeInfra(
  'S1R-13 outbox relay under concurrency and a failing consumer',
  ['db', 'redis'],
  () => {
    let db: TestDatabase;
    let worker: Awaited<ReturnType<typeof createTestWorker>>;
    let context: INestApplicationContext;

    beforeAll(async () => {
      db = await createTestDatabase();
      // The polling loop is replaced by a stub so that the tests drive the relays by hand.
      worker = await createTestWorker({ databaseUrl: db.url }, (builder) =>
        builder.overrideProvider(OutboxRelayLoop).useValue({}),
      );
      context = worker.context;
      context.get(EventConsumers).register({
        consumer: 'skip-locked-probe',
        types: ['platform.skip_locked_probe'],
        handle: async () => undefined,
      });
      context.get(EventConsumers).register({
        consumer: 'always-failing',
        types: ['platform.always_failing'],
        handle: async () => {
          throw new Error('contains personal data: alice@example.com');
        },
      });
    });

    afterAll(async () => {
      vi.restoreAllMocks();
      await worker.close();
      await db.drop();
    });

    async function seedEvents(count: number, type: string): Promise<void> {
      await db.sql`INSERT INTO platform.outbox_event (id, module, type, aggregate_id, payload, created_at)
      SELECT gen_random_uuid(), 'platform', ${type}, gen_random_uuid(), '{}'::jsonb, now()
      FROM generate_series(1, ${count})`;
    }

    it('two relays on one table: the second skips locked rows instead of waiting (SKIP LOCKED)', async () => {
      const total = OUTBOX_BATCH + 50;
      await seedEvents(total, 'skip_locked_probe');
      const relay = context.get(OutboxRelay);
      const queues = context.get(QueuesService);
      const delivered: string[] = [];
      let open!: () => void;
      const gate = new Promise<void>((resolve) => (open = resolve));
      let firstEntered!: () => void;
      const entered = new Promise<void>((resolve) => (firstEntered = resolve));
      vi.spyOn(queues, 'add').mockImplementation(async (_queue, _name, data) => {
        delivered.push((data as { event: { id: string } }).event.id);
        if (delivered.length > 1) return; // only the very first enqueue stays inside relay 1's transaction
        firstEntered();
        await gate;
      });
      try {
        const first = relay.runOnce();
        await entered; // relay 1 holds the row locks of its batch inside an open transaction
        const blocked = Symbol('blocked');
        const second = await Promise.race([
          relay.runOnce(),
          new Promise<symbol>((resolve) => setTimeout(() => resolve(blocked), 3000)),
        ]);
        expect(second, 'relay 2 must not wait for the locked rows').toBe(50);
        open();
        expect(await first).toBe(OUTBOX_BATCH);
      } finally {
        open();
        vi.restoreAllMocks();
      }
      expect(delivered).toHaveLength(total);
      expect(new Set(delivered).size).toBe(total);
      const pending = await db.sql`SELECT count(*)::int AS n FROM platform.outbox_event
      WHERE published_at IS NULL AND type = 'skip_locked_probe'`;
      expect(pending[0]?.n).toBe(0);
    });

    it('adding the same jobId twice leaves exactly one job in the BullMQ queue', async () => {
      const queues = context.get(QueuesService);
      const id = jobId('dedup-probe', randomUUID());
      const data = { consumer: 'dedup-probe' };
      await queues.add('timers', 'probe', data, { jobId: id, delayMs: 60_000 });
      await queues.add('timers', 'probe', data, { jobId: id, delayMs: 60_000 });
      const counts = await queues.getQueue('timers').getJobCounts('delayed', 'waiting', 'active');
      expect(counts.delayed).toBe(1);
      const job = await queues.getQueue('timers').getJob(id);
      expect(job?.id).toBe(id);
      await job?.remove();
    });

    it('a really failing job is parked in platform.event_dead_letter by the queue worker', async () => {
      const eventId = randomUUID();
      const aggregateId = randomUUID();
      const event = {
        id: eventId,
        module: 'platform',
        type: 'always_failing',
        aggregateId,
        payload: { n: 1 },
        requestId: null,
      };
      // attempts: 1 makes the first failure the last one; the queue default would retry for ~15 s.
      await context
        .get(QueuesService)
        .getQueue('events')
        .add(
          'deliver',
          { event, consumer: 'always-failing' },
          { jobId: jobId('always-failing', eventId), attempts: 1 },
        );
      const row = await waitFor(async () => {
        const rows =
          await db.sql`SELECT * FROM platform.event_dead_letter WHERE event_id = ${eventId}`;
        return rows[0];
      });
      expect(row).toMatchObject({
        consumer: 'always-failing',
        type: 'platform.always_failing',
        attempts: 1,
      });
      expect(String(row.error)).not.toContain('alice');
      expect(String(row.error)).not.toContain('personal data');
    });
  },
);
