import type { Redis } from 'ioredis';

/** The shape Better Auth expects for `secondaryStorage` (TTL in seconds). */
export interface SessionStorage {
  get(key: string): Promise<string | null>;
  getAndDelete(key: string): Promise<string | null>;
  increment(key: string, ttl: number): Promise<number>;
  set(key: string, value: string, ttl?: number): Promise<void>;
  delete(key: string): Promise<void>;
}

/** Key prefix granted to the `api` Redis user by the ACL (architecture 13.15). */
export const SESSION_KEY_PREFIX = 'better-auth:';

/** INCR that sets the expiry only when the key is created (fixed window), atomically. */
const INCREMENT_LUA = `
local value = redis.call('INCR', KEYS[1])
if value == 1 then redis.call('EXPIRE', KEYS[1], tonumber(ARGV[1])) end
return value`;

/**
 * Sessions live only in Redis (ADR-0009): Better Auth stores `<token>` and the per-user list
 * `active-sessions-<userId>` here, so losing Redis only logs everybody out.
 */
export function redisSessionStorage(redis: Redis): SessionStorage {
  const keyOf = (key: string): string => `${SESSION_KEY_PREFIX}${key}`;
  return {
    get: (key) => redis.get(keyOf(key)),
    getAndDelete: (key) => redis.getdel(keyOf(key)),
    async increment(key, ttl) {
      return Number(await redis.eval(INCREMENT_LUA, 1, keyOf(key), String(Math.ceil(ttl))));
    },
    async set(key, value, ttl) {
      if (ttl !== undefined && ttl > 0) await redis.set(keyOf(key), value, 'EX', Math.ceil(ttl));
      else await redis.set(keyOf(key), value);
    },
    async delete(key) {
      await redis.del(keyOf(key));
    },
  };
}
