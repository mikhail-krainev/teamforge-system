import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { call, codes, statuses } from '../helpers/http.js';
import { createTestApp, type TestApp } from '../helpers/app.js';
import { barrier, createTestDatabase, describeInfra, type TestDatabase } from '../helpers/infra.js';

const N = 20;

describeInfra(
  'S1-06 concurrency on infrastructure endpoints (architecture 12.5)',
  ['db', 'redis'],
  () => {
    let db: TestDatabase;
    let testApp: TestApp;
    let deadlocksBefore = 0;

    const deadlocks = async () =>
      Number(
        (await db.sql`SELECT deadlocks FROM pg_stat_database WHERE datname = current_database()`)[0]
          ?.deadlocks,
      );

    beforeAll(async () => {
      db = await createTestDatabase();
      testApp = await createTestApp({ databaseUrl: db.url, env: { DATABASE_POOL_MAX: '30' } });
      deadlocksBefore = await deadlocks();
    });

    afterAll(async () => {
      expect(await deadlocks()).toBe(deadlocksBefore);
      await testApp.close();
      await db.drop();
    });

    it('S1-06: 20 parallel requests with ONE key -> one effect, the rest 409 or replay', async () => {
      const options = { user: randomUUID(), key: randomUUID() };
      const gate = barrier(N);
      const results = await Promise.allSettled(
        Array.from({ length: N }, async () => {
          await gate.wait();
          return call(
            testApp.app,
            'POST',
            '/v1/_test/echo',
            { value: 'same', delayMs: 300 },
            options,
          );
        }),
      );
      const counts = statuses(results);
      expect(counts[201]).toBeGreaterThanOrEqual(1);
      expect((counts[201] ?? 0) + (counts[409] ?? 0)).toBe(N);
      expect(new Set(codes(results, 409))).toEqual(new Set(['IDEMPOTENCY_IN_PROGRESS']));
      const effects =
        await db.sql`SELECT count(*)::int AS n FROM public.tf_test_effect WHERE value = 'same'`;
      expect(effects[0]?.n).toBe(1);
      const events = await db.sql`SELECT count(*)::int AS n FROM platform.outbox_event`;
      expect(events[0]?.n).toBe(1);

      const replay = await call(
        testApp.app,
        'POST',
        '/v1/_test/echo',
        { value: 'same', delayMs: 300 },
        options,
      );
      expect(replay.statusCode).toBe(201);
      expect(replay.headers['idempotent-replayed']).toBe('true');
      const after =
        await db.sql`SELECT count(*)::int AS n FROM public.tf_test_effect WHERE value = 'same'`;
      expect(after[0]?.n).toBe(1);
    });

    it('CC-7 pattern: 20 different keys on a versioned resource -> 1 x 200, 19 x 409 VERSION_CONFLICT', async () => {
      const id = randomUUID();
      await db.sql`INSERT INTO public.tf_test_versioned (id, value) VALUES (${id}, 'start')`;
      const gate = barrier(N);
      const results = await Promise.allSettled(
        Array.from({ length: N }, async (_, i) => {
          await gate.wait();
          return call(testApp.app, 'PUT', `/v1/_test/versioned/${id}`, {
            version: 1,
            value: `v${i}`,
          });
        }),
      );
      expect(statuses(results)).toEqual({ 200: 1, 409: N - 1 });
      expect(codes(results, 409)).toEqual(Array(N - 1).fill('VERSION_CONFLICT'));
      const row = await db.sql`SELECT version FROM public.tf_test_versioned WHERE id = ${id}`;
      expect(row[0]?.version).toBe(2);
      const conflict = results.find((r) => r.status === 'fulfilled' && r.value.statusCode === 409);
      const body =
        conflict?.status === 'fulfilled'
          ? conflict.value.json<{ current: { version: number } }>()
          : null;
      expect(body?.current.version).toBe(2);
    });

    it('CC-7 pattern: a retry of the winner with the same key replays 200 without a second write', async () => {
      const id = randomUUID();
      await db.sql`INSERT INTO public.tf_test_versioned (id, value) VALUES (${id}, 'start')`;
      const options = { user: randomUUID(), key: randomUUID() };
      const first = await call(
        testApp.app,
        'PUT',
        `/v1/_test/versioned/${id}`,
        { version: 1, value: 'x' },
        options,
      );
      const replay = await call(
        testApp.app,
        'PUT',
        `/v1/_test/versioned/${id}`,
        { version: 1, value: 'x' },
        options,
      );
      expect(first.statusCode).toBe(200);
      expect(replay.statusCode).toBe(200);
      expect(replay.headers['idempotent-replayed']).toBe('true');
      const row = await db.sql`SELECT version FROM public.tf_test_versioned WHERE id = ${id}`;
      expect(row[0]?.version).toBe(2);
    });
  },
);
