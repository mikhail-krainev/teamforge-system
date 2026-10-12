import { randomUUID } from 'node:crypto';
import type { INestApplicationContext } from '@nestjs/common';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { EventConsumers } from '../../src/platform/outbox/event-consumers.js';
import { EventsProcessor } from '../../src/platform/outbox/events.processor.js';
import { OutboxRelay } from '../../src/platform/outbox/outbox-relay.js';
import { OutboxService } from '../../src/platform/outbox/outbox.service.js';
import type { OutboxEventData } from '../../src/platform/outbox/outbox.types.js';
import { TxRunner } from '../../src/platform/tx/tx-runner.js';
import type { QueueJob } from '../../src/platform/queues/queues.service.js';
import { createTestWorker } from '../helpers/app.js';
import { createTestDatabase, describeInfra, type TestDatabase, waitFor } from '../helpers/infra.js';

describeInfra('S1-06 transactional outbox, relay, inbox, dead letter', ['db', 'redis'], () => {
  let db: TestDatabase;
  let worker: Awaited<ReturnType<typeof createTestWorker>>;
  let context: INestApplicationContext;
  const handled: OutboxEventData[] = [];
  const aggregateId = randomUUID();

  beforeAll(async () => {
    db = await createTestDatabase();
    worker = await createTestWorker({ databaseUrl: db.url });
    context = worker.context;
    context.get(EventConsumers).register({
      consumer: 'unit-test-consumer',
      types: ['platform.test_event'],
      handle: async (event) => {
        handled.push(event);
      },
    });
  });

  afterAll(async () => {
    await worker.close();
    await db.drop();
  });

  const publish = (payload: Record<string, unknown>) =>
    context.get(TxRunner).run(() =>
      context.get(OutboxService).publish({
        module: 'platform',
        type: 'test_event',
        aggregateId,
        payload,
      }),
    );

  it('writes the event with the business change and rolls both back together', async () => {
    const runner = context.get(TxRunner);
    await expect(
      runner.run(async () => {
        await context.get(OutboxService).publish({
          module: 'platform',
          type: 'test_event',
          aggregateId,
          payload: { rolledBack: true },
        });
        throw new Error('abort');
      }),
    ).rejects.toThrow('abort');
    const rows =
      await db.sql`SELECT count(*)::int AS n FROM platform.outbox_event WHERE payload->>'rolledBack' = 'true'`;
    expect(rows[0]?.n).toBe(0);
  });

  it('refuses to publish outside a transaction', async () => {
    await expect(
      context
        .get(OutboxService)
        .publish({ module: 'platform', type: 'x', aggregateId, payload: {} }),
    ).rejects.toThrow(/inside a transaction/);
  });

  it('delivers a committed event to its consumer through relay, events queue and inbox', async () => {
    const eventId = await publish({ n: 1 });
    await waitFor(() => handled.find((e) => e.id === eventId));
    const inbox =
      await db.sql`SELECT count(*)::int AS n FROM platform.inbox_event WHERE event_id = ${eventId}`;
    expect(inbox[0]?.n).toBe(1);
    await waitFor(async () => {
      const rows =
        await db.sql`SELECT published_at FROM platform.outbox_event WHERE id = ${eventId}`;
      return rows[0]?.published_at;
    });
  });

  it('re-enqueueing a published event (crash after enqueue) delivers it only once', async () => {
    const eventId = await publish({ n: 2 });
    await waitFor(() => handled.find((e) => e.id === eventId));
    await db.sql`UPDATE platform.outbox_event SET published_at = NULL WHERE id = ${eventId}`;
    await context.get(OutboxRelay).runOnce();
    // The same jobId is deduplicated by BullMQ; a forced second delivery is dropped by the inbox.
    const processor = context.get(EventsProcessor);
    const event = handled.find((e) => e.id === eventId) as OutboxEventData;
    const job = { data: { event, consumer: 'unit-test-consumer' } } as unknown as QueueJob;
    expect(await processor.process(job)).toBe(false);
    expect(handled.filter((e) => e.id === eventId)).toHaveLength(1);
  });

  it('parks an event that failed its last attempt in platform.event_dead_letter', async () => {
    const processor = context.get(EventsProcessor);
    const event: OutboxEventData = {
      id: randomUUID(),
      module: 'platform',
      type: 'test_event',
      aggregateId,
      payload: { n: 3 },
      requestId: null,
    };
    const job = {
      data: { event, consumer: 'unit-test-consumer' },
      attemptsMade: 5,
    } as unknown as QueueJob;
    await processor.onExhausted(job, new Error('contains personal data'));
    await processor.onExhausted(job, new Error('again'));
    const rows =
      await db.sql`SELECT * FROM platform.event_dead_letter WHERE event_id = ${event.id}`;
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      consumer: 'unit-test-consumer',
      type: 'platform.test_event',
      attempts: 5,
    });
    expect(String(rows[0]?.error)).not.toContain('personal data');
  });

  it('cleans published outbox rows older than 7 days and inbox rows older than 14 days', async () => {
    const id = randomUUID();
    await db.sql`INSERT INTO platform.outbox_event (id, module, type, aggregate_id, payload, created_at, published_at)
      VALUES (${id}, 'platform', 'old', ${aggregateId}, '{}', now() - interval '9 days', now() - interval '8 days')`;
    await db.sql`INSERT INTO platform.inbox_event (consumer, event_id, processed_at)
      VALUES ('old-consumer', ${id}, now() - interval '15 days')`;
    const { MaintenanceProcessor } =
      await import('../../src/platform/outbox/maintenance.processor.js');
    const removed = await context.get(MaintenanceProcessor).cleanOutbox();
    expect(removed).toBeGreaterThanOrEqual(2);
    expect(await db.sql`SELECT 1 FROM platform.outbox_event WHERE id = ${id}`).toHaveLength(0);
  });
});
