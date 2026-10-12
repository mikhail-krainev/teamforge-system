import { randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { FixedClock } from '../../src/platform/clock/clock.js';
import {
  IdempotencyService,
  requestHash,
} from '../../src/platform/idempotency/idempotency.service.js';
import { IdempotencyStore } from '../../src/platform/idempotency/idempotency.store.js';
import { call, statuses } from '../helpers/http.js';
import { createTestApp, type TestApp } from '../helpers/app.js';
import {
  barrier,
  createTestDatabase,
  describeInfra,
  type TestDatabase,
  waitFor,
} from '../helpers/infra.js';

describeInfra('S1-06 idempotency interceptor (FR-WORK-08)', ['db', 'redis'], () => {
  let db: TestDatabase;
  let testApp: TestApp;
  const clock = new FixedClock(new Date());

  beforeAll(async () => {
    db = await createTestDatabase();
    testApp = await createTestApp({ databaseUrl: db.url, clock });
  });

  afterAll(async () => {
    await testApp.close();
    await db.drop();
  });

  beforeEach(async () => {
    clock.set(new Date());
    await db.sql.unsafe(
      'TRUNCATE public.tf_test_effect, platform.idempotency_key, platform.outbox_event',
    );
  });

  const effects = async () =>
    Number((await db.sql`SELECT count(*)::int AS n FROM public.tf_test_effect`)[0]?.n);

  it('rejects a mutating request without Idempotency-Key with 400 IDEMPOTENCY_KEY_MISSING', async () => {
    const response = await call(
      testApp.app,
      'POST',
      '/v1/_test/echo',
      { value: 'a' },
      { key: null },
    );
    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({ code: 'IDEMPOTENCY_KEY_MISSING' });
    expect(await effects()).toBe(0);
  });

  it('rejects a malformed key with 400', async () => {
    const response = await call(
      testApp.app,
      'POST',
      '/v1/_test/echo',
      { value: 'a' },
      { key: 'nope' },
    );
    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({ code: 'VALIDATION_FAILED' });
  });

  it('replays the stored response with Idempotent-Replayed: true and no second effect', async () => {
    const options = { user: randomUUID(), key: randomUUID() };
    const first = await call(testApp.app, 'POST', '/v1/_test/echo', { value: 'a' }, options);
    expect(first.statusCode).toBe(201);
    expect(first.headers['idempotent-replayed']).toBeUndefined();
    const again = await call(testApp.app, 'POST', '/v1/_test/echo', { value: 'a' }, options);
    expect(again.statusCode).toBe(201);
    expect(again.headers['idempotent-replayed']).toBe('true');
    expect(again.json()).toEqual(first.json());
    expect(await effects()).toBe(1);
    const events = await db.sql`SELECT count(*)::int AS n FROM platform.outbox_event`;
    expect(events[0]?.n).toBe(1);
  });

  it('answers 422 IDEMPOTENCY_KEY_REUSED when the same key carries another body', async () => {
    const options = { user: randomUUID(), key: randomUUID() };
    await call(testApp.app, 'POST', '/v1/_test/echo', { value: 'a' }, options);
    const reused = await call(testApp.app, 'POST', '/v1/_test/echo', { value: 'b' }, options);
    expect(reused.statusCode).toBe(422);
    expect(reused.json()).toMatchObject({ code: 'IDEMPOTENCY_KEY_REUSED' });
    expect(await effects()).toBe(1);
  });

  it('scopes keys per user: the same key for another user runs independently', async () => {
    const key = randomUUID();
    const one = await call(testApp.app, 'POST', '/v1/_test/echo', { value: 'a' }, { key });
    const two = await call(testApp.app, 'POST', '/v1/_test/echo', { value: 'a' }, { key });
    expect([one.statusCode, two.statusCode]).toEqual([201, 201]);
    expect(await effects()).toBe(2);
  });

  it('stores a domain rejection (4xx) and replays it without re-running', async () => {
    const options = { user: randomUUID(), key: randomUUID() };
    const first = await call(
      testApp.app,
      'POST',
      '/v1/_test/echo',
      { value: 'a', fail: 'domain' },
      options,
    );
    expect(first.statusCode).toBe(409);
    const again = await call(
      testApp.app,
      'POST',
      '/v1/_test/echo',
      { value: 'a', fail: 'domain' },
      options,
    );
    expect(again.statusCode).toBe(409);
    expect(again.headers['idempotent-replayed']).toBe('true');
    expect(again.headers['content-type']).toContain('application/problem+json');
    expect(again.json()).toMatchObject({ code: 'INVALID_STATE' });
    expect(await effects()).toBe(0);
  });

  it('releases the key after a 5xx so that a retry executes the operation', async () => {
    const options = { user: randomUUID(), key: randomUUID() };
    const failed = await call(
      testApp.app,
      'POST',
      '/v1/_test/echo',
      { value: 'a', fail: 'internal' },
      options,
    );
    expect(failed.statusCode).toBe(500);
    expect(failed.json()).toMatchObject({ code: 'INTERNAL' });
    const rows = await db.sql`SELECT count(*)::int AS n FROM platform.idempotency_key`;
    expect(rows[0]?.n).toBe(0);
    const retry = await call(testApp.app, 'POST', '/v1/_test/echo', { value: 'a' }, options);
    expect(retry.statusCode).toBe(201);
    expect(await effects()).toBe(1);
  });

  async function seedAbandonedClaim(user: string, key: string, lockedUntil: Date): Promise<void> {
    const hash = requestHash('testEcho', {}, { value: 'crash' });
    await db.sql`INSERT INTO platform.idempotency_key
      (user_id, key, operation_id, request_hash, status, locked_until, lock_token, created_at, expires_at)
      VALUES (${user}, ${key}, 'testEcho', ${hash}, 'in_progress', ${lockedUntil}, ${randomUUID()},
              ${clock.now()}, ${new Date(clock.now().getTime() + 86_400_000)})`;
  }

  it('answers 409 IDEMPOTENCY_IN_PROGRESS while another claim is alive', async () => {
    const user = randomUUID();
    const key = randomUUID();
    await seedAbandonedClaim(user, key, new Date(clock.now().getTime() + 60_000));
    const response = await call(
      testApp.app,
      'POST',
      '/v1/_test/echo',
      { value: 'crash' },
      { user, key },
    );
    expect(response.statusCode).toBe(409);
    expect(response.headers['retry-after']).toBe('1');
    expect(response.json()).toMatchObject({ code: 'IDEMPOTENCY_IN_PROGRESS' });
  });

  it('takes over a claim whose owner crashed before commit (expired lock) and runs once', async () => {
    const user = randomUUID();
    const key = randomUUID();
    await seedAbandonedClaim(user, key, new Date(clock.now().getTime() - 1000));
    const response = await call(
      testApp.app,
      'POST',
      '/v1/_test/echo',
      { value: 'crash' },
      { user, key },
    );
    expect(response.statusCode).toBe(201);
    expect(await effects()).toBe(1);
  });

  it('fences a slow request whose claim was taken over: it rolls back, one effect total', async () => {
    const options = { user: randomUUID(), key: randomUUID() };
    const slow = call(
      testApp.app,
      'POST',
      '/v1/_test/echo',
      { value: 'slow', delayMs: 1200 },
      options,
    );
    await new Promise((resolve) => setTimeout(resolve, 400));
    clock.advance(121_000);
    const taker = call(
      testApp.app,
      'POST',
      '/v1/_test/echo',
      { value: 'slow', delayMs: 1200 },
      options,
    );
    const late = await slow;
    expect(late.statusCode).toBe(409);
    expect(late.json()).toMatchObject({ code: 'IDEMPOTENCY_IN_PROGRESS' });
    expect((await taker).statusCode).toBe(201);
    expect(await effects()).toBe(1);
    const stored = await db.sql`SELECT status FROM platform.idempotency_key`;
    expect(stored.map((r) => r.status)).toEqual(['completed']);
  });

  it('removes keys past their 24 h TTL in the cleanup job', async () => {
    await call(testApp.app, 'POST', '/v1/_test/echo', { value: 'a' });
    clock.advance(25 * 3_600_000);
    const removed = await testApp.app.get(IdempotencyService).deleteExpired();
    expect(removed).toBe(1);
  });

  describe('S1R-02: one operation = one transaction, the key stores the HTTP response', () => {
    it('refuses a second top-level transaction under one key (500, no second effect)', async () => {
      const response = await call(testApp.app, 'POST', '/v1/_test/two-transactions', {
        value: 'twice',
      });
      expect(response.statusCode).toBe(500);
      expect(response.json()).toMatchObject({ code: 'INTERNAL' });
      const rows = await db.sql`SELECT value FROM public.tf_test_effect ORDER BY id`;
      expect(rows.map((r) => r.value)).toEqual(['twice-1']);
    });

    it('stores and replays the final HTTP body, not the raw result of the transaction', async () => {
      const options = { user: randomUUID(), key: randomUUID() };
      const first = await call(testApp.app, 'POST', '/v1/_test/dto', { value: 'v' }, options);
      expect(first.statusCode).toBe(201);
      expect(first.json()).toEqual({ id: 'v', shaped: true });
      const stored = await db.sql`SELECT response_body FROM platform.idempotency_key`;
      expect(stored[0]?.response_body).toEqual({ id: 'v', shaped: true });
      const again = await call(testApp.app, 'POST', '/v1/_test/dto', { value: 'v' }, options);
      expect(again.headers['idempotent-replayed']).toBe('true');
      expect(again.json()).toEqual({ id: 'v', shaped: true });
      expect(JSON.stringify(again.json())).not.toContain('must-not-leak');
      expect(await effects()).toBe(1);
    });
  });

  describe('S1R-02 follow-up: the raw transaction result is never replayed', () => {
    const store = () => testApp.app.get(IdempotencyStore);
    const rowOf = async (user: string, key: string) =>
      (
        await db.sql`SELECT status, response_provisional, response_body FROM platform.idempotency_key
        WHERE user_id = ${user} AND key = ${key}`
      )[0];

    afterEach(() => vi.restoreAllMocks());

    it('answers 409 IDEMPOTENCY_IN_PROGRESS between the commit and the final body, then replays the final body', async () => {
      const options = { user: randomUUID(), key: randomUUID() };
      const original = store().overwriteResponse.bind(store());
      const gate = barrier(2);
      vi.spyOn(store(), 'overwriteResponse').mockImplementation(async (ref, response) => {
        await gate.wait();
        return original(ref, response);
      });
      const first = call(testApp.app, 'POST', '/v1/_test/dto', { value: 'v' }, options);
      await waitFor(async () => (await rowOf(options.user, options.key))?.status === 'completed');
      expect(await rowOf(options.user, options.key)).toMatchObject({ response_provisional: true });
      const retry = await call(testApp.app, 'POST', '/v1/_test/dto', { value: 'v' }, options);
      expect(retry.statusCode).toBe(409);
      expect(retry.headers['retry-after']).toBe('1');
      expect(retry.json()).toMatchObject({ code: 'IDEMPOTENCY_IN_PROGRESS' });
      expect(JSON.stringify(retry.json())).not.toContain('must-not-leak');
      await gate.wait();
      expect((await first).json()).toEqual({ id: 'v', shaped: true });
      expect(await rowOf(options.user, options.key)).toMatchObject({ response_provisional: false });
      const again = await call(testApp.app, 'POST', '/v1/_test/dto', { value: 'v' }, options);
      expect(again.headers['idempotent-replayed']).toBe('true');
      expect(again.json()).toEqual({ id: 'v', shaped: true });
      expect(await effects()).toBe(1);
    });

    it('repeats a failed final write; the client still gets its answer', async () => {
      const options = { user: randomUUID(), key: randomUUID() };
      const original = store().overwriteResponse.bind(store());
      const spy = vi
        .spyOn(store(), 'overwriteResponse')
        .mockRejectedValueOnce(new Error('connection lost'))
        .mockImplementation(original);
      const first = await call(testApp.app, 'POST', '/v1/_test/dto', { value: 'r' }, options);
      expect(first.statusCode).toBe(201);
      expect(spy).toHaveBeenCalledTimes(2);
      expect(await rowOf(options.user, options.key)).toMatchObject({
        response_provisional: false,
        response_body: { id: 'r', shaped: true },
      });
      const again = await call(testApp.app, 'POST', '/v1/_test/dto', { value: 'r' }, options);
      expect(again.json()).toEqual({ id: 'r', shaped: true });
    });

    it('keeps the mark and refuses to replay the raw result when every final write fails', async () => {
      const options = { user: randomUUID(), key: randomUUID() };
      vi.spyOn(store(), 'overwriteResponse').mockRejectedValue(new Error('connection lost'));
      const first = await call(testApp.app, 'POST', '/v1/_test/dto', { value: 'x' }, options);
      expect(first.statusCode).toBe(201);
      expect(await rowOf(options.user, options.key)).toMatchObject({ response_provisional: true });
      const again = await call(testApp.app, 'POST', '/v1/_test/dto', { value: 'x' }, options);
      expect(again.statusCode).toBe(409);
      expect(JSON.stringify(again.json())).not.toContain('must-not-leak');
      expect(await effects()).toBe(1);
    });
  });

  describe('S1R-04: temporary answers do not become the final answer of a key', () => {
    const keyRows = async () =>
      Number((await db.sql`SELECT count(*)::int AS n FROM platform.idempotency_key`)[0]?.n);

    it('releases the key after a 429 inside the handler; the retry with the same key succeeds', async () => {
      const options = { user: randomUUID() };
      const body = { value: 'rl' };
      const ok = await call(testApp.app, 'POST', '/v1/_test/limited-write', body, options);
      expect(ok.statusCode).toBe(201);
      const key = randomUUID();
      const limited = await call(testApp.app, 'POST', '/v1/_test/limited-write', body, {
        ...options,
        key,
      });
      expect(limited.statusCode).toBe(429);
      expect(limited.headers['retry-after']).toBeDefined();
      expect(await db.sql`SELECT 1 FROM platform.idempotency_key WHERE key = ${key}`).toHaveLength(
        0,
      );
      const retried = await waitFor(
        async () => {
          const response = await call(testApp.app, 'POST', '/v1/_test/limited-write', body, {
            ...options,
            key,
          });
          return response.statusCode === 201 ? response : false;
        },
        5000,
        200,
      );
      expect(retried.headers['idempotent-replayed']).toBeUndefined();
      expect(retried.json()).toEqual({ value: 'rl' });
    });

    it.each(['rate_limited', 'unavailable'] as const)(
      'does not store a %s answer: the claim is released',
      async (fail) => {
        const response = await call(testApp.app, 'POST', '/v1/_test/echo', { value: 'a', fail });
        expect([429, 503]).toContain(response.statusCode);
        expect(await keyRows()).toBe(0);
        expect(await effects()).toBe(0);
      },
    );

    it('still stores a definitive 4xx (409) as the answer', async () => {
      await call(testApp.app, 'POST', '/v1/_test/echo', { value: 'a', fail: 'domain' });
      const rows = await db.sql`SELECT status, response_status FROM platform.idempotency_key`;
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ status: 'completed', response_status: 409 });
    });
  });

  describe('S1R-13: takeover of an expired claim (mutation: the expiry condition)', () => {
    const lockOf = async (user: string, key: string) =>
      (
        await db.sql`SELECT lock_token FROM platform.idempotency_key
        WHERE user_id = ${user} AND key = ${key}`
      )[0]?.lock_token as string | undefined;

    it('does not take over a claim whose lock is still alive and keeps its fencing token', async () => {
      const [user, key] = [randomUUID(), randomUUID()];
      await seedAbandonedClaim(user, key, new Date(clock.now().getTime() + 60_000));
      const before = await lockOf(user, key);
      const taken = await testApp.app
        .get(IdempotencyStore)
        .takeOver(user, key, clock.now(), 120_000);
      expect(taken).toBeUndefined();
      expect(await lockOf(user, key)).toBe(before);
    });

    it('lets exactly one of two simultaneous takeovers of an expired claim win', async () => {
      const [user, key] = [randomUUID(), randomUUID()];
      await seedAbandonedClaim(user, key, new Date(clock.now().getTime() - 1000));
      const store = testApp.app.get(IdempotencyStore);
      const gate = barrier(2);
      const attempt = async () => {
        await gate.wait();
        return store.takeOver(user, key, clock.now(), 120_000);
      };
      const results = await Promise.all([attempt(), attempt()]);
      expect(results.filter((token) => token !== undefined)).toHaveLength(1);
      expect(await lockOf(user, key)).toBe(results.find((token) => token !== undefined));
    });

    it('runs the operation once when two requests meet an expired claim', async () => {
      const [user, key] = [randomUUID(), randomUUID()];
      await seedAbandonedClaim(user, key, new Date(clock.now().getTime() - 1000));
      const send = () =>
        call(testApp.app, 'POST', '/v1/_test/echo', { value: 'crash' }, { user, key });
      const results = await Promise.allSettled([send(), send()]);
      expect(await effects()).toBe(1);
      const counts = statuses(results);
      expect(counts[201]).toBeGreaterThanOrEqual(1);
      expect((counts[201] ?? 0) + (counts[409] ?? 0)).toBe(2);
    });
  });

  it('does not require a key for safe methods', async () => {
    const response = await call(testApp.app, 'GET', '/v1/_test/ip', undefined, { key: null });
    expect(response.statusCode).toBe(200);
  });
});
