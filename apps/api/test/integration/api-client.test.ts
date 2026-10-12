import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { user } from '../fixtures/index.js';
import { api } from '../helpers/api.js';
import { createTestApp, type TestApp } from '../helpers/app.js';
import { expectMatchesContract } from '../helpers/contract.js';
import { createTestDatabase, describeInfra, type TestDatabase } from '../helpers/infra.js';

/** Examples of the shared helpers working on the infrastructure endpoints (`/v1/_test/echo`). */
describeInfra('S1-10 api.as(user) and contract check on the live app', ['db', 'redis'], () => {
  let db: TestDatabase;
  let app: TestApp;

  beforeAll(async () => {
    db = await createTestDatabase();
    app = await createTestApp({ databaseUrl: db.url });
  });

  afterAll(async () => {
    await app.close();
    await db.drop();
  });

  it('healthReady answers with a body that matches the contract', async () => {
    const response = await api(app.app).anonymous().get('/health/ready');
    expect(response.statusCode).toBe(200);
    expectMatchesContract('healthReady', response);
  });

  it('FR-WORK-08: api.as() sends a fresh Idempotency-Key per call and replays an explicit one', async () => {
    const alice = api(app.app).as(user('alice'));
    const first = await alice.post('/v1/_test/echo', { value: 'one' });
    const second = await alice.post('/v1/_test/echo', { value: 'one' });
    expect(first.statusCode).toBe(201);
    expect(second.json<{ effects: number }>().effects).toBe(2);

    const key = { idempotencyKey: randomUUID() };
    const original = await alice.post('/v1/_test/echo', { value: 'two' }, key);
    const replay = await alice.post('/v1/_test/echo', { value: 'two' }, key);
    expect(replay.headers['idempotent-replayed']).toBe('true');
    expect(replay.body).toBe(original.body);
  });

  it('a mutating call without a key is rejected with IDEMPOTENCY_KEY_MISSING', async () => {
    const response = await api(app.app)
      .as(user('alice'))
      .post('/v1/_test/echo', { value: 'x' }, { idempotencyKey: null });
    expect(response.statusCode).toBe(400);
    expect(response.json<{ code: string }>().code).toBe('IDEMPOTENCY_KEY_MISSING');
  });
});
