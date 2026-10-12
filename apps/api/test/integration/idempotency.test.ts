import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, expect, it } from 'vitest';
import { FixedClock } from '../../src/platform/clock/clock.js';
import {
  IdempotencyService,
  requestHash,
} from '../../src/platform/idempotency/idempotency.service.js';
import { call } from '../helpers/http.js';
import { createTestApp, type TestApp } from '../helpers/app.js';
import { createTestDatabase, describeInfra, type TestDatabase } from '../helpers/infra.js';

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

  it('does not require a key for safe methods', async () => {
    const response = await call(testApp.app, 'GET', '/v1/_test/ip', undefined, { key: null });
    expect(response.statusCode).toBe(200);
  });
});
