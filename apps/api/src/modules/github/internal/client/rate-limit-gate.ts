import { Inject, Injectable } from '@nestjs/common';
import type { Redis } from 'ioredis';
import { Clock } from '../../../../platform/clock/clock.js';
import { REDIS } from '../../../../platform/redis/redis.module.js';
import type { GithubError } from './github-error.js';

/** Under the prefix the ACL of `api` and `worker` already allows (docker/redis/users.acl.tpl). */
const KEY = 'gh_inst_token:rate-limit-pause';
/** Without a `Retry-After` or a reset time a limit is respected this long (GitHub asks for a minute). */
export const DEFAULT_PAUSE_MS = 60_000;
/** The key outlives the pause by this much in real time; the pause itself is read from the clock of the application. */
const KEY_SLACK_SECONDS = 120;
const MAX_PAUSE_MS = 2 * 60 * 60 * 1000;

/**
 * The pause GitHub asked for (`Retry-After` of a secondary limit, the reset of an exhausted quota).
 * The limits belong to the App and its address, not to one installation, so one pause stops every
 * background read until it ends (FR-GH-06). Interactive requests are not held by it.
 */
@Injectable()
export class RateLimitGate {
  constructor(
    @Inject(REDIS) private readonly redis: Redis,
    @Inject(Clock) private readonly clock: Clock,
  ) {}

  /** The moment the pause ends, or `null` when there is none. */
  async pausedUntil(): Promise<Date | null> {
    const raw = await this.redis.get(KEY);
    if (raw === null) return null;
    const until = Number(raw);
    if (Number.isFinite(until) && until > this.clock.now().getTime()) return new Date(until);
    // The pause is over: the key must not outlive it, a later reader may run by another clock.
    await this.redis.del(KEY);
    return null;
  }

  /** Records the pause a limit asked for and returns when it ends. Never shortens a longer pause. */
  async pauseFor(error: GithubError): Promise<Date> {
    const now = this.clock.now().getTime();
    const byRetryAfter = error.retryAfterMs === undefined ? 0 : now + error.retryAfterMs;
    const byReset = error.resetAt?.getTime() ?? 0;
    const known = Math.max(byRetryAfter, byReset);
    const until = Math.min(known > 0 ? known : now + DEFAULT_PAUSE_MS, now + MAX_PAUSE_MS);
    const current = Number(await this.redis.get(KEY));
    const next = Math.max(current, until);
    const ttl = Math.ceil((next - now) / 1000) + KEY_SLACK_SECONDS;
    await this.redis.set(KEY, String(next), 'EX', Math.max(ttl, KEY_SLACK_SECONDS));
    return new Date(next);
  }
}
