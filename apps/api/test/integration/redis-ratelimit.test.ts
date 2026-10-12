import { randomUUID } from 'node:crypto';
import { Redis } from 'ioredis';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { loadConfig } from '../../src/platform/config/config.js';
import { RateLimiter } from '../../src/platform/ratelimit/rate-limiter.js';
import { createTestApp, type TestApp } from '../helpers/app.js';
import { validEnv } from '../helpers/env.js';
import { describeInfra, waitFor } from '../helpers/infra.js';

describeInfra('S1-07 rate limiter (real Redis, Lua sliding window)', ['redis'], () => {
  let redis: Redis;
  let limiter: RateLimiter;
  let testApp: TestApp;

  beforeAll(async () => {
    redis = new Redis(process.env.REDIS_URL ?? '');
    limiter = new RateLimiter(redis, loadConfig(validEnv(), 'api'));
    testApp = await createTestApp({});
  });

  afterAll(async () => {
    await testApp.close();
    await redis.quit();
  });

  it('S1-07: 30 parallel calls with threshold 5 let exactly 5 through', async () => {
    const subject = `user:${randomUUID()}`;
    const results = await Promise.all(
      Array.from({ length: 30 }, () =>
        limiter.consume('apiWrite', subject, { limit: 5, windowMs: 60_000 }),
      ),
    );
    expect(results.filter((r) => r.allowed)).toHaveLength(5);
    expect(results.filter((r) => !r.allowed)).toHaveLength(25);
    const rejected = results.find((r) => !r.allowed);
    expect(rejected?.retryAfterSeconds).toBeGreaterThan(0);
    expect(rejected?.remaining).toBe(0);
  });

  it('counts remaining hits and slides the window', async () => {
    const subject = `user:${randomUUID()}`;
    const rule = { limit: 2, windowMs: 400 };
    expect((await limiter.consume('apiRead', subject, rule)).remaining).toBe(1);
    expect((await limiter.consume('apiRead', subject, rule)).remaining).toBe(0);
    expect((await limiter.consume('apiRead', subject, rule)).allowed).toBe(false);
    await waitFor(async () => (await limiter.consume('apiRead', subject, rule)).allowed);
  });

  it('keeps separate counters per category and subject, and never stores raw IPs or e-mails', async () => {
    const ipSubject = limiter.ipSubject('203.0.113.7');
    const emailSubject = limiter.emailSubject(' User@Example.COM ');
    expect(emailSubject).toBe(limiter.emailSubject('user@example.com'));
    await limiter.consume('authLinkIp', ipSubject);
    await limiter.consume('authLinkEmail', emailSubject);
    const keys = await redis.keys(`rl:*:*${ipSubject.slice(3, 20)}*`);
    expect(keys.join()).not.toContain('203.0.113.7');
    const emailKeys = await redis.keys(`rl:authLinkEmail:email:*`);
    expect(emailKeys.join().toLowerCase()).not.toContain('example.com');
  });

  it('S1-07 slice test: HTTP 429 carries Retry-After and RateLimit-* headers', async () => {
    const remoteAddress = `10.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250)}.9`;
    const hit = () =>
      testApp.app.inject({
        method: 'GET',
        url: '/api/v1/_test/limited',
        headers: { 'x-test-user': 'u' },
        remoteAddress,
      });
    for (let i = 0; i < 3; i += 1) expect((await hit()).statusCode).toBe(200);
    const limited = await hit();
    expect(limited.statusCode).toBe(429);
    expect(limited.headers['retry-after']).toMatch(/^\d+$/);
    expect(limited.headers['ratelimit-limit']).toBe('3');
    expect(limited.headers['ratelimit-remaining']).toBe('0');
    expect(Number(limited.headers['ratelimit-reset'])).toBeGreaterThan(0);
    expect(limited.json()).toMatchObject({ status: 429, code: 'RATE_LIMITED' });
  });
});
