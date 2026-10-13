import { APIError } from 'better-auth/api';
import type { BetterAuthOptions } from 'better-auth';
import { and, eq, ne } from 'drizzle-orm';
import type { Redis } from 'ioredis';
import type { Database } from '../../../../platform/db/db.module.js';
import { account } from '../schema/auth.js';
import { SESSION_KEY_PREFIX } from './redis-secondary-storage.js';

const GITHUB = 'github';
const LOCK_SECONDS = 30;

type AccountHooks = NonNullable<NonNullable<BetterAuthOptions['databaseHooks']>['account']>;

const alreadyLinked = (): APIError =>
  new APIError('CONFLICT', {
    code: 'GITHUB_ALREADY_LINKED',
    message: 'This GitHub account is already linked to another user',
  });

const lockKey = (accountId: string): string => `${SESSION_KEY_PREFIX}lock:github:${accountId}`;

/** Deletes the lock only while it still belongs to this user (it may have expired and been retaken). */
const RELEASE_IF_OWNER =
  "if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('del', KEYS[1]) else return 0 end";

async function releaseLock(redis: Redis, accountId: string, userId: string): Promise<void> {
  try {
    await redis.eval(RELEASE_IF_OWNER, 1, lockKey(accountId), userId);
  } catch {
    // The lock expires on its own after LOCK_SECONDS.
  }
}

/** True when another user holds the lock; the same user's own leftover lock (failed insert) is reused. */
async function heldByAnother(redis: Redis, accountId: string, userId: string): Promise<boolean> {
  const taken = await redis.set(lockKey(accountId), userId, 'EX', LOCK_SECONDS, 'NX');
  if (taken !== null) return false;
  return (await redis.get(lockKey(accountId))) !== userId;
}

async function ownedByAnother(db: Database, userId: string, accountId: string): Promise<boolean> {
  const rows = await db
    .select({ id: account.id })
    .from(account)
    .where(
      and(
        eq(account.providerId, GITHUB),
        eq(account.accountId, accountId),
        ne(account.userId, userId),
      ),
    )
    .limit(1);
  return rows.length > 0;
}

async function clearTokens(db: Database, userId: string, accountId: string): Promise<void> {
  await db
    .update(account)
    .set({
      accessToken: null,
      refreshToken: null,
      idToken: null,
      accessTokenExpiresAt: null,
      refreshTokenExpiresAt: null,
    })
    .where(
      and(
        eq(account.providerId, GITHUB),
        eq(account.accountId, accountId),
        eq(account.userId, userId),
      ),
    );
}

/**
 * One GitHub account belongs to one user (FR-AUTH-05, AF-15). A short Redis lock per GitHub id
 * serialises concurrent attempts, the check under it refuses an account owned by someone else, and
 * the unique index `account_provider_account_uq` stays the last line of defence. The OAuth tokens
 * are cleared right after the account row is written: the platform has no use for them (FR-GH-10).
 */
export function githubAccountHooks(db: Database, redis: Redis): AccountHooks {
  return {
    create: {
      before: async (created) => {
        if (created.providerId !== GITHUB) return;
        if (await heldByAnother(redis, created.accountId, created.userId)) throw alreadyLinked();
        try {
          if (await ownedByAnother(db, created.userId, created.accountId)) throw alreadyLinked();
        } catch (error) {
          // No `after` hook will run for a refused account: do not leave a lock behind (S2CR-04).
          await releaseLock(redis, created.accountId, created.userId);
          throw error;
        }
      },
      after: async (created) => {
        if (created.providerId !== GITHUB) return;
        try {
          await clearTokens(db, created.userId, created.accountId);
        } finally {
          await releaseLock(redis, created.accountId, created.userId);
        }
      },
    },
    update: {
      after: async (updated) => {
        if (updated.providerId === GITHUB && updated.userId && updated.accountId) {
          await clearTokens(db, updated.userId, updated.accountId);
        }
      },
    },
  };
}
