import { describe, expect, it } from 'vitest';
import { validEnv } from '../../../test/helpers/env.js';
import { loadConfig } from '../config/config.js';
import { DomainError } from '../errors/domain-error.js';
import { RateLimiter, hashSubject, isLoopbackClient, rateLimitHeaders } from './rate-limiter.js';

type Reply = (number | undefined)[];

/** In-memory stand-in for the two Lua commands: it only replays the scripted replies. */
function scriptedRedis(window: Reply, peek: Reply) {
  return {
    defineCommand: () => undefined,
    tfSlidingWindow: async () => window,
    tfWindowPeek: async () => peek,
  };
}

function limiterWith(window: Reply, peek: Reply, env: Record<string, string> = {}): RateLimiter {
  const config = loadConfig(validEnv(env), 'api');
  return new RateLimiter(scriptedRedis(window, peek) as never, config);
}

describe('RateLimiter replies', () => {
  it('turns a rejected hit into 0 remaining and rounds the waits up to whole seconds', async () => {
    const limiter = limiterWith([0, -3, 1500, 2100], []);
    const result = await limiter.consume('authLogin', 'ip:x');
    expect(result).toEqual({
      allowed: false,
      limit: 10,
      remaining: 0,
      retryAfterSeconds: 2,
      resetSeconds: 3,
    });
  });

  it('treats a reply without counters as an exhausted window with no wait', async () => {
    const limiter = limiterWith([0], []);
    const result = await limiter.consume('apiRead', 'user:1', { limit: 3, windowMs: 1000 });
    expect(result).toMatchObject({ allowed: false, limit: 3, remaining: 0, retryAfterSeconds: 0 });
  });

  it('enforce throws 429 with Retry-After of at least one second and RateLimit headers', async () => {
    const limiter = limiterWith([0, 0, 0, 0], []);
    const error = await limiter.enforce('authLogin', 'ip:x').catch((e: unknown) => e);
    expect(error).toBeInstanceOf(DomainError);
    expect((error as DomainError).status).toBe(429);
    expect((error as DomainError).data.headers).toMatchObject({
      'Retry-After': '1',
      'RateLimit-Limit': '10',
      'RateLimit-Remaining': '0',
    });
  });

  it('enforce returns the result while the window has room', async () => {
    const limiter = limiterWith([1, 4, 0, 1000], []);
    const result = await limiter.enforce('apiWrite', 'user:1');
    expect(result).toMatchObject({ allowed: true, remaining: 4, resetSeconds: 1 });
  });

  it('assertBelowLimit passes silently when the peek allows', async () => {
    const limiter = limiterWith([], [1, 5, 0, 0]);
    await expect(limiter.assertBelowLimit('resumeUpload', 'user:1')).resolves.toBeUndefined();
  });

  it('assertBelowLimit throws 429 without counters when the peek rejects', async () => {
    const limiter = limiterWith([], [0]);
    const error = await limiter.assertBelowLimit('resumeUpload', 'user:1').catch((e: unknown) => e);
    expect(error).toMatchObject({ code: 'RATE_LIMITED', status: 429 });
    expect((error as DomainError).data.retryAfterSeconds).toBe(0);
  });

  it('assertBelowLimit reports the wait of a full window', async () => {
    const limiter = limiterWith([], [0, 0, 61_000, 90_000]);
    const error = await limiter.assertBelowLimit('resumeUpload', 'user:1').catch((e: unknown) => e);
    expect((error as DomainError).data.retryAfterSeconds).toBe(61);
  });
});

describe('RateLimiter subjects and loopback exemption', () => {
  it('never puts a raw ip or e-mail into a subject and normalizes the e-mail', () => {
    const limiter = limiterWith([], []);
    const config = loadConfig(validEnv(), 'api');
    expect(limiter.ipSubject('203.0.113.5')).toBe(
      `ip:${hashSubject(config.IP_HASH_SALT, '203.0.113.5')}`,
    );
    expect(limiter.emailSubject('  Alice@Example.TEST ')).toBe(
      limiter.emailSubject('alice@example.test'),
    );
    expect(limiter.emailSubject('a@example.test')).not.toContain('example');
    expect(limiter.userSubject('u1')).toBe('user:u1');
  });

  it('exempts only loopback addresses and only when the flag is on', () => {
    limiterWith([], [], { RATE_LIMIT_EXEMPT_LOOPBACK: 'false' });
    expect(isLoopbackClient('127.0.0.1')).toBe(false);
    limiterWith([], [], { RATE_LIMIT_EXEMPT_LOOPBACK: 'true' });
    expect(isLoopbackClient('127.0.0.1')).toBe(true);
    expect(isLoopbackClient('::ffff:127.0.0.1')).toBe(true);
    expect(isLoopbackClient('203.0.113.5')).toBe(false);
    limiterWith([], [], { RATE_LIMIT_EXEMPT_LOOPBACK: 'false' });
  });

  it('builds the RateLimit-* headers from a result', () => {
    expect(
      rateLimitHeaders({
        allowed: true,
        limit: 5,
        remaining: 2,
        retryAfterSeconds: 0,
        resetSeconds: 9,
      }),
    ).toEqual({ 'RateLimit-Limit': '5', 'RateLimit-Remaining': '2', 'RateLimit-Reset': '9' });
  });
});
