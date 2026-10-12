import type { Redis } from 'ioredis';
import { describe, expect, it } from 'vitest';
import { parseRedisCredentials, RedisAclError, verifyRedisAcl } from './redis-acl.js';

function fakeRedis(whoami: string): Redis {
  return { call: async () => whoami } as unknown as Redis;
}

describe('verifyRedisAcl', () => {
  it('parses credentials from the URL', () => {
    expect(parseRedisCredentials('redis://api:s3cr%40t@host:6379')).toEqual({
      username: 'api',
      hasPassword: true,
    });
    expect(parseRedisCredentials('redis://host:6379')).toEqual({
      username: '',
      hasPassword: false,
    });
  });

  it('passes when the server reports the expected user', async () => {
    await expect(
      verifyRedisAcl(fakeRedis('api'), 'redis://api:pw@h:1', true),
    ).resolves.toBeUndefined();
  });

  it('refuses URLs without user name or password in strict mode', async () => {
    await expect(verifyRedisAcl(fakeRedis('default'), 'redis://h:1', true)).rejects.toBeInstanceOf(
      RedisAclError,
    );
    await expect(verifyRedisAcl(fakeRedis('api'), 'redis://api@h:1', true)).rejects.toBeInstanceOf(
      RedisAclError,
    );
  });

  it('refuses a user mismatch without leaking the password', async () => {
    const error = await verifyRedisAcl(fakeRedis('default'), 'redis://api:hunter2@h:1', true).catch(
      (e: Error) => e,
    );
    expect(error).toBeInstanceOf(RedisAclError);
    expect((error as Error).message).not.toContain('hunter2');
  });

  it('skips all checks when not strict', async () => {
    await expect(
      verifyRedisAcl(fakeRedis('default'), 'redis://h:1', false),
    ).resolves.toBeUndefined();
  });
});
