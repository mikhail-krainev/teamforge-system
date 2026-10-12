import type { Redis } from 'ioredis';

export class RedisAclError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RedisAclError';
  }
}

/** User name and password parts of a Redis URL (decoded). */
export function parseRedisCredentials(url: string): { username: string; hasPassword: boolean } {
  const parsed = new URL(url);
  return {
    username: decodeURIComponent(parsed.username),
    hasPassword: decodeURIComponent(parsed.password) !== '',
  };
}

/**
 * Startup check (architecture 13.16, SEC-10): the URL must carry a user name and password and the
 * server must report the same user for `ACL WHOAMI`; otherwise the process does not start.
 * Messages never contain the password.
 */
export async function verifyRedisAcl(client: Redis, url: string, strict: boolean): Promise<void> {
  if (!strict) return;
  const { username, hasPassword } = parseRedisCredentials(url);
  if (username === '' || !hasPassword) {
    throw new RedisAclError('REDIS_URL must include an ACL user name and password');
  }
  const whoami = await client.call('ACL', 'WHOAMI');
  if (whoami !== username) {
    throw new RedisAclError(`ACL WHOAMI returned "${String(whoami)}", expected "${username}"`);
  }
}
