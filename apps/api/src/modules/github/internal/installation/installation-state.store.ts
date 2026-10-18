import { createHash, randomBytes } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import type { Redis } from 'ioredis';
import { z } from 'zod';
import { REDIS } from '../../../../platform/redis/redis.module.js';

/** Architecture 7.2: the `state` of an installation lives ten minutes. */
export const STATE_TTL_SECONDS = 600;
const STATE_BYTES = 32;
/**
 * `gh_state:` is shared with the login cache `gh_state:cache:login:<login>` (7.2). A `state` is
 * base64url and has no colon, and its key is the hash of it, so it can name no other key.
 */
const KEY_PREFIX = 'gh_state:';
const STATE_SHAPE = /^[A-Za-z0-9_-]{16,128}$/;

const stateValue = z.object({ teamId: z.uuid(), userId: z.uuid() });
export type InstallationState = z.infer<typeof stateValue>;

const keyOf = (state: string): string =>
  `${KEY_PREFIX}${createHash('sha256').update(state).digest('base64url')}`;

/** One-time `state` of the installation flow: who started it and for which team (SEC-02). */
@Injectable()
export class InstallationStateStore {
  constructor(@Inject(REDIS) private readonly redis: Redis) {}

  /** Returns the new `state`; Redis keeps only its hash, so a dump of Redis holds no usable value. */
  async issue(value: InstallationState): Promise<string> {
    const state = randomBytes(STATE_BYTES).toString('base64url');
    await this.redis.set(keyOf(state), JSON.stringify(value), 'EX', STATE_TTL_SECONDS, 'NX');
    return state;
  }

  /**
   * Reads and deletes the `state` in one atomic command (GETDEL): of ten parallel redirects only one
   * gets the value. `null` for an unknown, used, expired or malformed `state`; a malformed one never
   * reaches Redis.
   */
  async consume(state: string): Promise<InstallationState | null> {
    if (!STATE_SHAPE.test(state)) return null;
    const stored = await this.redis.getdel(keyOf(state));
    if (stored === null) return null;
    const parsed = stateValue.safeParse(JSON.parse(stored));
    return parsed.success ? parsed.data : null;
  }
}
