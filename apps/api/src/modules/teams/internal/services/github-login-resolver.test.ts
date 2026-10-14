import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { AppConfig } from '../../../../platform/config/config.js';
import { DomainError } from '../../../../platform/errors/domain-error.js';
import type { RateLimiter } from '../../../../platform/ratelimit/rate-limiter.js';
import { HttpGithubLoginResolver } from './github-login-resolver.js';

/** Redis stand-in with `get` and `set ... EX` (the TTL itself is not simulated). */
class FakeRedis {
  readonly data = new Map<string, string>();
  readonly ttls = new Map<string, number>();
  get(key: string): Promise<string | null> {
    return Promise.resolve(this.data.get(key) ?? null);
  }
  set(key: string, value: string, _ex: 'EX', seconds: number): Promise<'OK'> {
    this.data.set(key, value);
    this.ttls.set(key, seconds);
    return Promise.resolve('OK');
  }
}

/** Counts per subject; refuses with 429 once `max` hits of a subject are used. */
class FakeLimiter {
  readonly hits = new Map<string, number>();
  constructor(private readonly max: number) {}
  userSubject(userId: string): string {
    return `user:${userId}`;
  }
  enforce(_category: string, subject: string): Promise<void> {
    const used = (this.hits.get(subject) ?? 0) + 1;
    this.hits.set(subject, used);
    if (used > this.max) {
      return Promise.reject(new DomainError('RATE_LIMITED', 429));
    }
    return Promise.resolve();
  }
}

describe('HttpGithubLoginResolver (SEC-18)', () => {
  let server: Server;
  let resolver: HttpGithubLoginResolver;
  let redis: FakeRedis;
  let limiter: FakeLimiter;
  let calls: string[];
  let baseUrl: string;

  const build = (max = 100): HttpGithubLoginResolver => {
    redis = new FakeRedis();
    limiter = new FakeLimiter(max);
    return new HttpGithubLoginResolver(
      { GITHUB_API_BASE_URL: baseUrl } as unknown as AppConfig,
      redis as never,
      limiter as unknown as RateLimiter,
    );
  };

  beforeAll(async () => {
    server = createServer((req, res) => {
      const login = decodeURIComponent((req.url ?? '').replace('/users/', ''));
      calls.push(login);
      res.setHeader('Content-Type', 'application/json');
      if (login === 'octocat') {
        res.end(JSON.stringify({ id: 583231, login: 'octocat', type: 'User' }));
      } else if (login === 'some-org') {
        res.end(JSON.stringify({ id: 9, login: 'some-org', type: 'Organization' }));
      } else if (login === 'garbled') {
        res.end(JSON.stringify({ nope: true }));
      } else if (login === 'limited') {
        res.statusCode = 403;
        res.end('{}');
      } else {
        res.statusCode = 404;
        res.end('{}');
      }
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address() as AddressInfo;
    baseUrl = `http://127.0.0.1:${port}`;
  });

  beforeEach(() => {
    calls = [];
    resolver = build();
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it('returns the numeric id and the spelling GitHub reports', async () => {
    expect(await resolver.resolve('octocat', 'u1')).toEqual({ id: 583231, login: 'octocat' });
  });

  it('returns null for an unknown login and for an organisation', async () => {
    expect(await resolver.resolve('nobody', 'u1')).toBeNull();
    expect(await resolver.resolve('some-org', 'u1')).toBeNull();
  });

  it('answers 503 when GitHub refuses, sends an unreadable body, or cannot be reached', async () => {
    for (const login of ['limited', 'garbled']) {
      await expect(resolver.resolve(login, 'u1')).rejects.toMatchObject({ status: 503 });
    }
    const dead = new HttpGithubLoginResolver(
      { GITHUB_API_BASE_URL: 'http://127.0.0.1:1' } as unknown as AppConfig,
      new FakeRedis() as never,
      new FakeLimiter(100) as unknown as RateLimiter,
    );
    const error = await dead.resolve('octocat', 'u1').catch((e: unknown) => e);
    expect(error).toBeInstanceOf(DomainError);
    expect((error as DomainError).status).toBe(503);
  });

  it('S3SEC-02: the second lookup of a login is served from the cache, with no call to GitHub', async () => {
    expect(await resolver.resolve('octocat', 'u1')).toEqual({ id: 583231, login: 'octocat' });
    expect(await resolver.resolve('OctoCat', 'u2')).toEqual({ id: 583231, login: 'octocat' });
    expect(calls).toEqual(['octocat']);
    expect(limiter.hits.get('github-login:user:u2')).toBeUndefined();
    expect(redis.ttls.get('gh_state:cache:login:octocat')).toBe(3600);
  });

  it('S3SEC-02: an unknown login is cached briefly, a GitHub failure is not cached', async () => {
    expect(await resolver.resolve('nobody', 'u1')).toBeNull();
    expect(await resolver.resolve('nobody', 'u1')).toBeNull();
    expect(calls).toEqual(['nobody']);
    expect(redis.ttls.get('gh_state:cache:login:nobody')).toBe(300);
    await resolver.resolve('limited', 'u1').catch(() => undefined);
    await resolver.resolve('limited', 'u1').catch(() => undefined);
    expect(calls.filter((c) => c === 'limited')).toHaveLength(2);
  });

  it('S3SEC-02: lookups over the per-user limit answer 429 and do not reach GitHub', async () => {
    resolver = build(3);
    for (const login of ['a1', 'a2', 'a3']) await resolver.resolve(login, 'u1');
    expect(calls).toHaveLength(3);
    const error = await resolver.resolve('a4', 'u1').catch((e: unknown) => e);
    expect(error).toMatchObject({ status: 429 });
    expect(calls).toHaveLength(3);
  });

  it('S3SEC-02: a cached login is answered even when the user is over the limit', async () => {
    resolver = build(1);
    await resolver.resolve('octocat', 'u1');
    expect(await resolver.resolve('octocat', 'u1')).toEqual({ id: 583231, login: 'octocat' });
    expect(calls).toEqual(['octocat']);
  });
});
