import { describe, expect, it } from 'vitest';
import { forbiddenVariables, loadLinkCheckerEnv, LinkCheckerEnvError } from './env.js';

const BASE = { REDIS_LINKCHECK_URL: 'redis://linkcheck:secret@redis:6379' };

describe('loadLinkCheckerEnv', () => {
  it('takes the Redis user, the prefix, own addresses and limits, with defaults', () => {
    expect(loadLinkCheckerEnv(BASE)).toEqual({
      redisUrl: BASE.REDIS_LINKCHECK_URL,
      queuePrefix: 'bull',
      selfPublicIps: [],
      concurrency: 5,
      timeoutMs: 10_000,
      totalTimeoutMs: 30_000,
    });
    expect(
      loadLinkCheckerEnv({
        ...BASE,
        QUEUE_PREFIX: 'tf-test',
        SELF_PUBLIC_IPS: '203.0.114.7, 2a01:4f8::1 ,',
        LINK_CHECK_CONCURRENCY: '2',
        LINK_CHECK_TIMEOUT_MS: '5000',
      }),
    ).toMatchObject({
      queuePrefix: 'tf-test',
      selfPublicIps: ['203.0.114.7', '2a01:4f8::1'],
      concurrency: 2,
      timeoutMs: 5000,
    });
  });

  it('refuses to start when a database, storage, session or GitHub secret is present, naming the variable only', () => {
    for (const name of [
      'DATABASE_URL',
      'DATABASE_DIRECT_URL',
      'S3_SECRET_KEY',
      'BETTER_AUTH_SECRET',
      'GITHUB_APP_PRIVATE_KEY',
      'DATA_ENCRYPTION_KEY',
      'REDIS_URL',
    ]) {
      const env = { ...BASE, [name]: 'super-secret-value' };
      expect(() => loadLinkCheckerEnv(env), name).toThrow(LinkCheckerEnvError);
      expect(() => loadLinkCheckerEnv(env), name).toThrow(new RegExp(name));
      expect(() => loadLinkCheckerEnv(env)).not.toThrow(/super-secret-value/);
    }
    expect(forbiddenVariables({ ...BASE, DATABASE_URL: '' })).toEqual([]);
  });

  it('refuses a missing or malformed Redis URL and out-of-range numbers', () => {
    expect(() => loadLinkCheckerEnv({})).toThrow(/REDIS_LINKCHECK_URL/);
    expect(() => loadLinkCheckerEnv({ REDIS_LINKCHECK_URL: 'http://x' })).toThrow(
      /REDIS_LINKCHECK_URL/,
    );
    expect(() => loadLinkCheckerEnv({ ...BASE, LINK_CHECK_CONCURRENCY: '0' })).toThrow(
      /CONCURRENCY/,
    );
    expect(() => loadLinkCheckerEnv({ ...BASE, QUEUE_PREFIX: 'Bad Prefix' })).toThrow(
      /QUEUE_PREFIX/,
    );
  });

  it('fails closed in production: SELF_PUBLIC_IPS must name the public addresses of the server', () => {
    expect(() => loadLinkCheckerEnv({ ...BASE, NODE_ENV: 'production' })).toThrow(
      /SELF_PUBLIC_IPS/,
    );
    expect(() =>
      loadLinkCheckerEnv({ ...BASE, NODE_ENV: 'production', SELF_PUBLIC_IPS: ' , ' }),
    ).toThrow(/SELF_PUBLIC_IPS/);
    expect(
      loadLinkCheckerEnv({ ...BASE, NODE_ENV: 'production', SELF_PUBLIC_IPS: '203.0.114.7' })
        .selfPublicIps,
    ).toEqual(['203.0.114.7']);
    expect(loadLinkCheckerEnv({ ...BASE, NODE_ENV: 'development' }).selfPublicIps).toEqual([]);
  });

  it('takes the total deadline of one check, with a default above the time of a hop', () => {
    expect(loadLinkCheckerEnv(BASE).totalTimeoutMs).toBe(30_000);
    expect(
      loadLinkCheckerEnv({ ...BASE, LINK_CHECK_TOTAL_TIMEOUT_MS: '45000' }).totalTimeoutMs,
    ).toBe(45_000);
  });
});
