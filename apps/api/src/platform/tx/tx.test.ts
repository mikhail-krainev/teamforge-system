import { PgDialect } from 'drizzle-orm/pg-core';
import { describe, expect, it, vi } from 'vitest';
import type { AppConfig } from '../config/config.js';
import { DomainError, InvariantError } from '../errors/domain-error.js';
import { LockService } from './locks.js';
import { TxHooks } from './tx-hooks.js';
import { TxRunner, type TxHost } from './tx-runner.js';

const dialect = new PgDialect();

function pgError(code: string): Error {
  return Object.assign(new Error('pg'), { code });
}

function fakeCls() {
  const store = new Map<string, unknown>();
  return {
    isActive: () => true,
    run: <T>(fn: () => T) => fn(),
    set: (key: string, value: unknown) => void store.set(key, value),
    get: (key: string) => store.get(key),
  };
}

function fakeHost(statements: string[] = [], rows: unknown[] = []) {
  let active = false;
  const tx = {
    execute: vi.fn(async (query: Parameters<PgDialect['sqlToQuery']>[0]) => {
      statements.push(dialect.sqlToQuery(query).sql);
      return rows;
    }),
  };
  return {
    isTransactionActive: () => active,
    tx,
    withTransaction: async (fn: () => Promise<unknown>) => {
      active = true;
      try {
        return await fn();
      } finally {
        active = false;
      }
    },
  };
}

function runnerWith(host: ReturnType<typeof fakeHost>, hooks = new TxHooks()) {
  return new TxRunner(host as unknown as TxHost, fakeCls() as never, hooks);
}

describe('TxRunner', () => {
  it('issues SET LOCAL lock_timeout and statement_timeout before the scenario', async () => {
    const statements: string[] = [];
    const runner = runnerWith(fakeHost(statements));
    await runner.run(async () => {
      statements.push('scenario');
    });
    expect(statements).toEqual([
      "SET LOCAL lock_timeout = '5s'",
      "SET LOCAL statement_timeout = '10s'",
      'scenario',
    ]);
  });

  it('rejects malformed interval literals (no SQL injection through options)', async () => {
    const runner = runnerWith(fakeHost());
    await expect(runner.run(async () => 1, { lockTimeout: "1s'; DROP" })).rejects.toThrow(
      /Invalid interval/,
    );
  });

  it('retries 40P01 and 40001 up to 3 times, then answers 503 LOCK_TIMEOUT', async () => {
    const runner = runnerWith(fakeHost());
    let calls = 0;
    const error = await runner
      .run(
        async () => {
          calls += 1;
          throw pgError(calls % 2 === 0 ? '40001' : '40P01');
        },
        { jitterMaxMs: 1 },
      )
      .catch((e: unknown) => e);
    expect(calls).toBe(4);
    expect(error).toMatchObject({ code: 'LOCK_TIMEOUT', status: 503 });
  });

  it('succeeds when a retry passes and runs listeners once per attempt', async () => {
    const hooks = new TxHooks();
    const before = vi.fn(async () => undefined);
    const after = vi.fn(async () => undefined);
    hooks.register({ beforeCommit: before, afterCommit: after });
    const runner = runnerWith(fakeHost(), hooks);
    let calls = 0;
    const result = await runner.run(
      async () => {
        calls += 1;
        if (calls === 1) throw pgError('40P01');
        return 'ok';
      },
      { jitterMaxMs: 1 },
    );
    expect(result).toBe('ok');
    expect(before).toHaveBeenCalledTimes(1);
    expect(before).toHaveBeenCalledWith('ok');
    expect(after).toHaveBeenCalledTimes(1);
  });

  it('M-6: afterCommit work runs once after the commit; a failed attempt drops what it queued; a rollback runs none', async () => {
    const runner = runnerWith(fakeHost());
    const done: string[] = [];
    let calls = 0;
    await runner.run(
      async () => {
        calls += 1;
        await runner.afterCommit(async () => void done.push(`attempt-${calls}`));
        expect(done).toEqual([]);
        if (calls === 1) throw pgError('40P01');
      },
      { jitterMaxMs: 1 },
    );
    expect(done).toEqual(['attempt-2']);
    await runner
      .run(async () => {
        await runner.afterCommit(async () => void done.push('rolled-back'));
        throw new Error('boom');
      })
      .catch(() => undefined);
    expect(done).toEqual(['attempt-2']);
    await runner.afterCommit(async () => void done.push('outside'));
    expect(done).toEqual(['attempt-2', 'outside']);
  });

  it('M-6: afterCommit work queued inside the transaction runs after the commit when the transaction has its own (inherited) CLS store', async () => {
    // `@nestjs-cls/transactional` runs the transaction in `cls.run({ ifNested: 'inherit' })`: a shallow copy of
    // the store, so a `set` inside it is not seen outside.
    let store = new Map<string, unknown>();
    const cls = {
      isActive: () => true,
      run: async <T>(fn: () => Promise<T>) => {
        const outer = store;
        store = new Map(outer);
        try {
          return await fn();
        } finally {
          store = outer;
        }
      },
      set: (key: string, value: unknown) => void store.set(key, value),
      get: (key: string) => store.get(key),
    };
    const host = fakeHost();
    const inherited = {
      ...host,
      withTransaction: (fn: () => Promise<unknown>) => cls.run(() => host.withTransaction(fn)),
    };
    const runner = new TxRunner(inherited as unknown as TxHost, cls as never, new TxHooks());
    const done: string[] = [];
    await runner.run(async () => {
      await runner.afterCommit(async () => void done.push('timer'));
    });
    expect(done).toEqual(['timer']);
  });

  it('turns 55P03 into 503 LOCK_TIMEOUT without retrying and passes other errors through', async () => {
    const runner = runnerWith(fakeHost());
    let calls = 0;
    const timeout = await runner
      .run(async () => {
        calls += 1;
        throw pgError('55P03');
      })
      .catch((e: unknown) => e);
    expect(timeout).toBeInstanceOf(DomainError);
    expect(calls).toBe(1);
    await expect(runner.run(async () => Promise.reject(new Error('plain')))).rejects.toThrow(
      'plain',
    );
  });

  it('S1R-02: refuses a second top-level transaction once the idempotency key committed', async () => {
    const cls = fakeCls();
    const idempotency = { completedInTx: false, committed: false };
    cls.set('idempotency', idempotency);
    const runner = new TxRunner(fakeHost() as unknown as TxHost, cls as never, new TxHooks());
    await runner.run(async () => 1);
    expect(idempotency.committed).toBe(true);
    const error = await runner.run(async () => 2).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(InvariantError);
    expect(String(error)).toMatch(/exactly one transaction/);
  });

  it('S1R-02: a rolled back first transaction does not block a second one', async () => {
    const cls = fakeCls();
    const idempotency = { completedInTx: false, committed: false };
    cls.set('idempotency', idempotency);
    const runner = new TxRunner(fakeHost() as unknown as TxHost, cls as never, new TxHooks());
    await runner
      .run(async () => Promise.reject(new Error('domain rejection')))
      .catch(() => undefined);
    expect(idempotency.committed).toBe(false);
    await expect(runner.run(async () => 2)).resolves.toBe(2);
  });

  it('S1R-05: past the attempt deadline the commit hooks do not run and the scenario fails', async () => {
    const hooks = new TxHooks();
    const before = vi.fn(async () => undefined);
    hooks.register({ beforeCommit: before });
    const runner = runnerWith(fakeHost(), hooks);
    const error = await runner
      .run(async () => new Promise((resolve) => setTimeout(() => resolve('late'), 120)), {
        attemptTimeoutMs: 30,
      })
      .catch((e: unknown) => e);
    expect(error).toMatchObject({ code: 'LOCK_TIMEOUT', status: 503 });
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(before).not.toHaveBeenCalled();
  });

  it('joins an already active transaction instead of opening a new one', async () => {
    const host = fakeHost();
    const runner = runnerWith(host);
    const result = await runner.run(() => runner.run(async () => host.isTransactionActive()));
    expect(result).toBe(true);
  });
});

describe('LockService order (architecture 12.1)', () => {
  const config = { NODE_ENV: 'test' } as AppConfig;

  function locks(rows: unknown[] = [{ id: 'x' }]) {
    const statements: string[] = [];
    const host = fakeHost(statements, rows);
    void host.withTransaction(async () => undefined);
    const service = new LockService(
      { ...host, isTransactionActive: () => true, tx: host.tx } as unknown as TxHost,
      fakeCls() as never,
      config,
    );
    return { service, statements };
  }

  it('allows skipping levels and repeating a level', async () => {
    const { service } = locks();
    await service.lockUser('a');
    await service.lockTeam('b');
    await service.lockSeats(['c']);
    await service.lockSeats(['d']);
  });

  it('throws when a lower level is taken after a higher one (test mode)', async () => {
    const { service } = locks();
    await service.lockTeam('b');
    await expect(service.lockUser('a')).rejects.toBeInstanceOf(InvariantError);
    await expect(service.lockSearchApplication('a')).rejects.toThrow(/level 2 .* after level 4/);
  });

  it('does not throw outside test mode', async () => {
    const host = fakeHost([], [{ id: 'x' }]);
    const service = new LockService(
      { ...host, isTransactionActive: () => true } as unknown as TxHost,
      fakeCls() as never,
      { NODE_ENV: 'production' } as AppConfig,
    );
    await service.lockTeam('b');
    await expect(service.lockUser('a')).resolves.toBeDefined();
  });

  it('uses the lock modes of the table and sorts several ids ascending', async () => {
    const { service, statements } = locks();
    await service.lockUser('a');
    await service.lockTeam('b', 'share');
    await service.lockSeats(['b', 'a']);
    expect(statements[0]).toContain('FROM "auth"."user"');
    expect(statements[0]).toMatch(/FOR NO KEY UPDATE$/);
    expect(statements[1]).toContain('"teams"."team"');
    expect(statements[1]).toMatch(/FOR SHARE$/);
    expect(statements[2]).toMatch(/FOR UPDATE$/);
  });

  it('requires an active transaction', async () => {
    const host = fakeHost();
    const service = new LockService(host as unknown as TxHost, fakeCls() as never, config);
    await expect(service.lockUser('a')).rejects.toThrow(/outside a transaction/);
  });
});
