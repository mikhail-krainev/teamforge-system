import { describe, expect, it } from 'vitest';
import { githubAccountHooks } from './github-account-hooks.js';

/** Minimal in-memory stand-in for the Redis commands the hooks use. */
function fakeRedis() {
  const store = new Map<string, string>();
  return {
    store,
    set: async (key: string, value: string) => {
      if (store.has(key)) return null;
      store.set(key, value);
      return 'OK';
    },
    get: async (key: string) => store.get(key) ?? null,
    eval: async (_script: string, _count: number, key: string, owner: string) => {
      if (store.get(key) === owner) return store.delete(key) ? 1 : 0;
      return 0;
    },
  };
}

function fakeDb(ownedByAnother: boolean) {
  const chain = {
    from: () => chain,
    where: () => chain,
    set: () => chain,
    limit: async () => (ownedByAnother ? [{ id: 'x' }] : []),
  };
  return { select: () => chain, update: () => chain };
}

const account = (userId: string) => ({ providerId: 'github', accountId: '42', userId }) as never;

describe('githubAccountHooks lock (S2CR-04)', () => {
  it('a failed account insert does not give the same user a false 409 on retry', async () => {
    const redis = fakeRedis();
    const hooks = githubAccountHooks(fakeDb(false) as never, redis as never);
    await hooks.create?.before?.(account('u1'), null);
    // the insert failed: `after` never ran and the lock is still there
    await expect(hooks.create?.before?.(account('u1'), null)).resolves.not.toThrow();
  });

  it('another user is refused while the lock is held', async () => {
    const redis = fakeRedis();
    const hooks = githubAccountHooks(fakeDb(false) as never, redis as never);
    await hooks.create?.before?.(account('u1'), null);
    await expect(hooks.create?.before?.(account('u2'), null)).rejects.toMatchObject({
      body: { code: 'GITHUB_ALREADY_LINKED' },
    });
  });

  it('a refused account (owned by another user) leaves no lock behind', async () => {
    const redis = fakeRedis();
    const hooks = githubAccountHooks(fakeDb(true) as never, redis as never);
    await expect(hooks.create?.before?.(account('u1'), null)).rejects.toBeDefined();
    expect(redis.store.size).toBe(0);
  });

  it('after releases only its own lock', async () => {
    const redis = fakeRedis();
    const hooks = githubAccountHooks(fakeDb(false) as never, redis as never);
    await hooks.create?.before?.(account('u1'), null);
    await hooks.create?.after?.(account('u2'), null);
    expect(redis.store.size).toBe(1);
    await hooks.create?.after?.(account('u1'), null);
    expect(redis.store.size).toBe(0);
  });
});
