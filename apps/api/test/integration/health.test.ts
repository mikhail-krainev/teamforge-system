import { afterAll, beforeAll, expect, it } from 'vitest';
import { createTestApp, type TestApp } from '../helpers/app.js';
import { createTestDatabase, describeInfra, type TestDatabase } from '../helpers/infra.js';

describeInfra(
  'S1-03 health and error format (api, real PostgreSQL + Redis)',
  ['db', 'redis'],
  () => {
    let db: TestDatabase;
    let healthy: TestApp;

    beforeAll(async () => {
      db = await createTestDatabase();
      healthy = await createTestApp({ databaseUrl: db.url });
    });

    afterAll(async () => {
      await healthy.close();
      await db.drop();
    });

    it('healthLive answers 200 without touching dependencies', async () => {
      const response = await healthy.app.inject({ method: 'GET', url: '/api/health/live' });
      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({ status: 'ok', checks: {} });
    });

    it('healthReady answers 200 when PostgreSQL, Redis and S3 are reachable', async () => {
      const response = await healthy.app.inject({ method: 'GET', url: '/api/health/ready' });
      expect(response.statusCode).toBe(200);
      const body = response.json<{ status: string; checks: Record<string, { status: string }> }>();
      expect(body.status).toBe('ok');
      expect(Object.keys(body.checks).sort()).toEqual(['postgres', 'redis', 's3']);
    });

    it('healthReady answers 503 when Redis is unreachable', async () => {
      const broken = await createTestApp({
        databaseUrl: db.url,
        redisUrl: 'redis://127.0.0.1:1',
      });
      try {
        const response = await broken.app.inject({ method: 'GET', url: '/api/health/ready' });
        expect(response.statusCode).toBe(503);
        const body = response.json<{ checks: Record<string, { status: string }> }>();
        expect(body.checks.redis?.status).toBe('down');
        expect(body.checks.postgres?.status).toBe('ok');
      } finally {
        await broken.close();
      }
    });

    it('healthReady answers 503 when S3 is unreachable', async () => {
      const broken = await createTestApp({
        databaseUrl: db.url,
        env: { S3_ENDPOINT: 'http://127.0.0.1:1' },
      });
      try {
        const response = await broken.app.inject({ method: 'GET', url: '/api/health/ready' });
        expect(response.statusCode).toBe(503);
        expect(
          response.json<{ checks: Record<string, { status: string }> }>().checks.s3?.status,
        ).toBe('down');
      } finally {
        await broken.close();
      }
    });

    it('answers unknown routes with problem+json carrying code and requestId', async () => {
      const response = await healthy.app.inject({ method: 'GET', url: '/api/v1/nope' });
      expect(response.statusCode).toBe(404);
      expect(response.headers['content-type']).toContain('application/problem+json');
      expect(response.json()).toMatchObject({
        status: 404,
        code: 'NOT_FOUND',
        requestId: response.headers['x-request-id'],
      });
    });

    it('answers malformed JSON with problem+json 400', async () => {
      const response = await healthy.app.inject({
        method: 'POST',
        url: '/api/v1/_test/echo',
        headers: { 'content-type': 'application/json', 'x-test-user': 'u' },
        payload: '{broken',
      });
      expect(response.statusCode).toBe(400);
      expect(response.json()).toMatchObject({ status: 400, code: 'VALIDATION_FAILED' });
    });

    it('keeps a valid X-Request-Id and generates one otherwise', async () => {
      const given = await healthy.app.inject({
        method: 'GET',
        url: '/api/health/live',
        headers: { 'x-request-id': 'client-req-12345' },
      });
      expect(given.headers['x-request-id']).toBe('client-req-12345');
      const generated = await healthy.app.inject({
        method: 'GET',
        url: '/api/health/live',
        headers: { 'x-request-id': 'bad id!' },
      });
      expect(generated.headers['x-request-id']).toMatch(/^[0-9a-f-]{36}$/);
    });

    it('logs request_id and route but never URL, query string or headers (SEC-07)', async () => {
      await healthy.app.inject({
        method: 'GET',
        url: '/api/health/live?token=SECRET-TOKEN&code=oauth-code',
        headers: { cookie: 'session=SECRET-COOKIE', 'x-request-id': 'log-check-123456' },
      });
      const lines = healthy.logs.join('\n');
      expect(lines).toContain('log-check-123456');
      expect(lines).toContain('"operation_id":"healthLive"');
      expect(lines).toContain('"route":"/api/health/live"');
      for (const secret of ['SECRET-TOKEN', 'oauth-code', 'SECRET-COOKIE', 'token=']) {
        expect(lines).not.toContain(secret);
      }
    });
  },
);
