import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { createTestApp, type TestApp } from './helpers/app.js';

const opened: TestApp[] = [];
async function open(options: Parameters<typeof createTestApp>[0] = {}): Promise<TestApp> {
  const testApp = await createTestApp(options);
  opened.push(testApp);
  return testApp;
}

afterAll(async () => {
  await Promise.all(opened.map((testApp) => testApp.close()));
});

const PRODUCTION = { NODE_ENV: 'production', REDIS_ACL_STRICT: 'false' };

describe('S1R-09 security headers of the API (architecture 13.10)', () => {
  it('sets nosniff, no framing, no referrer, CORP and no-store on every response', async () => {
    const { app } = await open();
    const urls = ['/api/health/live', '/api/no-such-route'];
    for (const url of urls) {
      const response = await app.inject({ method: 'GET', url });
      expect(response.headers['x-content-type-options'], url).toBe('nosniff');
      expect(response.headers['x-frame-options'], url).toBe('DENY');
      expect(response.headers['content-security-policy'], url).toBe(
        "default-src 'none'; frame-ancestors 'none'",
      );
      expect(response.headers['referrer-policy'], url).toBe('no-referrer');
      expect(response.headers['cross-origin-resource-policy'], url).toBe('same-origin');
      expect(response.headers['cache-control'], url).toBe('no-store');
    }
  });

  it('also protects problem+json errors raised by the application', async () => {
    const { app } = await open();
    const response = await app.inject({ method: 'POST', url: '/api/v1/_test/echo', payload: {} });
    expect(response.statusCode).toBe(401);
    expect(response.headers['x-content-type-options']).toBe('nosniff');
    expect(response.headers['content-type']).toContain('application/problem+json');
  });

  it('adds HSTS in production only', async () => {
    const development = await open();
    const dev = await development.app.inject({ method: 'GET', url: '/api/health/live' });
    expect(dev.headers['strict-transport-security']).toBeUndefined();
    const production = await open({ env: PRODUCTION });
    const prod = await production.app.inject({ method: 'GET', url: '/api/health/live' });
    expect(prod.headers['strict-transport-security']).toBe('max-age=31536000; includeSubDomains');
  });
});

describe('S1R-08 the test session never reaches production', () => {
  it('an application started like production has no test-support routes', async () => {
    const { app } = await open({ testSupport: false, env: PRODUCTION });
    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/_test/echo',
      headers: { 'x-test-user': 'attacker', 'idempotency-key': crypto.randomUUID() },
      payload: { value: 'x' },
    });
    expect(response.statusCode).toBe(404);
  });

  it('even with the test module present, X-Test-User is ignored when NODE_ENV is production', async () => {
    const { app } = await open({ env: PRODUCTION });
    const response = await app.inject({
      method: 'GET',
      url: '/api/v1/_test/ip',
      headers: { 'x-test-user': 'attacker' },
    });
    expect(response.statusCode).toBe(401);
    expect(response.json()).toMatchObject({ code: 'UNAUTHENTICATED' });
  });

  it('honours the header in the test configuration (control)', async () => {
    const { app } = await open();
    const response = await app.inject({
      method: 'GET',
      url: '/api/v1/_test/ip',
      headers: { 'x-test-user': 'tester' },
    });
    expect(response.statusCode).toBe(200);
  });

  it('nothing under src/ knows the test header, the test controller or the test module', () => {
    const root = resolve(import.meta.dirname, '../src');
    const offenders: string[] = [];
    const walk = (dir: string): void => {
      for (const name of readdirSync(dir)) {
        const path = join(dir, name);
        if (statSync(path).isDirectory()) walk(path);
        else if (/\.ts$/.test(name) && !name.endsWith('.test.ts')) {
          const text = readFileSync(path, 'utf8').toLowerCase();
          if (
            /x-test-user|testsupportmodule|testsupportcontroller|testsessionauthenticator|tf_test_/.test(
              text,
            )
          )
            offenders.push(path);
        }
      }
    };
    walk(root);
    expect(offenders).toEqual([]);
  });
});
