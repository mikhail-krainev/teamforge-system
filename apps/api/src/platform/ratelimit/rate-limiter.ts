import { createHmac, randomUUID } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import { Redis } from 'ioredis';
import { APP_CONFIG } from '../config/config.module.js';
import type { AppConfig } from '../config/config.js';
import { DomainError } from '../errors/domain-error.js';
import { REDIS } from '../redis/redis.module.js';

export interface RateLimitRule {
  limit: number;
  windowMs: number;
}

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

/** Limits per category (architecture 13.6). */
export const RATE_LIMITS = {
  authLinkEmail: { limit: 5, windowMs: HOUR },
  authLinkIp: { limit: 20, windowMs: HOUR },
  authLogin: { limit: 10, windowMs: 15 * MINUTE },
  resumeUpload: { limit: 5, windowMs: HOUR },
  artifactUpload: { limit: 30, windowMs: HOUR },
  apiRead: { limit: 120, windowMs: MINUTE },
  apiWrite: { limit: 60, windowMs: MINUTE },
  linkCheckTeam: { limit: 30, windowMs: HOUR },
  linkCheckUser: { limit: 30, windowMs: HOUR },
  githubWebhook: { limit: 600, windowMs: MINUTE },
  deletionCancel: { limit: 10, windowMs: HOUR },
} as const satisfies Record<string, RateLimitRule>;

const LOOPBACK_CLIENTS = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);

/**
 * True when the client address is the loopback itself: a process inside the container, never a
 * browser (proxied clients arrive with their own address, SEC-16). Per-IP limits of anonymous
 * operations skip such requests.
 */
export function isLoopbackClient(ip: string): boolean {
  return LOOPBACK_CLIENTS.has(ip);
}

export type RateLimitCategory = keyof typeof RATE_LIMITS;

export interface RateLimitResult {
  allowed: boolean;
  limit: number;
  remaining: number;
  /** Seconds until a rejected caller may retry (0 when allowed). */
  retryAfterSeconds: number;
  /** Seconds until the oldest counted hit leaves the window. */
  resetSeconds: number;
}

/**
 * Sliding window in a sorted set, evaluated atomically in Lua with the Redis clock.
 * Returns {allowed, remaining, retryAfterMs, resetMs}.
 */
const SLIDING_WINDOW_LUA = `
local t = redis.call('TIME')
local now = t[1] * 1000 + math.floor(t[2] / 1000)
local limit = tonumber(ARGV[1])
local window = tonumber(ARGV[2])
redis.call('ZREMRANGEBYSCORE', KEYS[1], '-inf', now - window)
local count = redis.call('ZCARD', KEYS[1])
local allowed = 0
if count < limit then
  redis.call('ZADD', KEYS[1], now, ARGV[3])
  redis.call('PEXPIRE', KEYS[1], window)
  allowed = 1
  count = count + 1
end
local oldest = redis.call('ZRANGE', KEYS[1], 0, 0, 'WITHSCORES')
local reset = window - (now - tonumber(oldest[2]))
local retry = 0
if allowed == 0 then retry = reset end
return {allowed, limit - count, retry, reset}
`;

type RateLimitCommand = Redis & {
  tfSlidingWindow(key: string, limit: number, windowMs: number, member: string): Promise<number[]>;
};

/** HMAC of a value with IP_HASH_SALT: Redis keys never contain raw IPs or e-mail addresses. */
export function hashSubject(salt: string, value: string): string {
  return createHmac('sha256', salt).update(value).digest('hex');
}

@Injectable()
export class RateLimiter {
  private readonly redis: RateLimitCommand;

  constructor(
    @Inject(REDIS) redis: Redis,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {
    redis.defineCommand('tfSlidingWindow', { numberOfKeys: 1, lua: SLIDING_WINDOW_LUA });
    this.redis = redis as RateLimitCommand;
  }

  ipSubject(ip: string): string {
    return `ip:${hashSubject(this.config.IP_HASH_SALT, ip)}`;
  }

  emailSubject(email: string): string {
    return `email:${hashSubject(this.config.IP_HASH_SALT, email.trim().toLowerCase())}`;
  }

  userSubject(userId: string): string {
    return `user:${userId}`;
  }

  /** Counts one hit. `rule` overrides the category default (tests, per-route tuning). */
  async consume(
    category: RateLimitCategory,
    subject: string,
    rule: RateLimitRule = RATE_LIMITS[category],
  ): Promise<RateLimitResult> {
    const key = `rl:${category}:${subject}`;
    const [allowed, remaining, retryMs, resetMs] = await this.redis.tfSlidingWindow(
      key,
      rule.limit,
      rule.windowMs,
      randomUUID(),
    );
    return {
      allowed: allowed === 1,
      limit: rule.limit,
      remaining: Math.max(0, remaining ?? 0),
      retryAfterSeconds: Math.ceil((retryMs ?? 0) / 1000),
      resetSeconds: Math.ceil((resetMs ?? 0) / 1000),
    };
  }

  /** Like consume, but throws 429 RATE_LIMITED with Retry-After and RateLimit-* headers. */
  async enforce(
    category: RateLimitCategory,
    subject: string,
    rule?: RateLimitRule,
  ): Promise<RateLimitResult> {
    const result = await this.consume(category, subject, rule);
    if (!result.allowed) throw rateLimitedError(result);
    return result;
  }
}

export function rateLimitHeaders(result: RateLimitResult): Record<string, string> {
  return {
    'RateLimit-Limit': String(result.limit),
    'RateLimit-Remaining': String(result.remaining),
    'RateLimit-Reset': String(result.resetSeconds),
  };
}

export function rateLimitedError(result: RateLimitResult): DomainError {
  return new DomainError('RATE_LIMITED', 429, {
    retryAfterSeconds: result.retryAfterSeconds,
    headers: {
      'Retry-After': String(Math.max(1, result.retryAfterSeconds)),
      ...rateLimitHeaders(result),
    },
  });
}
