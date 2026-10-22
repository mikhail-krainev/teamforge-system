import { describe, expect, it, vi } from 'vitest';
import { InvariantError } from '../errors/domain-error.js';
import { type Database, guardSharedClient } from './db.module.js';

function fakeDatabase() {
  const select = vi.fn(() => 'query');
  const transaction = vi.fn(() => 'tx');
  return { raw: { select, transaction } as unknown as Database, select, transaction };
}

describe('guardSharedClient (pool starvation guard, architecture 12.1)', () => {
  it('passes statements through outside a transaction', () => {
    const { raw, select } = fakeDatabase();
    const db = guardSharedClient(raw, () => false);
    expect(db.select()).toBe('query');
    expect(select).toHaveBeenCalledOnce();
  });

  it('refuses a statement on the shared client while a transaction is active', () => {
    const { raw, select } = fakeDatabase();
    const db = guardSharedClient(raw, () => true);
    expect(() => db.select()).toThrow(InvariantError);
    expect(() => db.select()).toThrow(/TxRunner\.tx/);
    expect(select).not.toHaveBeenCalled();
  });

  it('still lets the transaction itself start while a transaction is active', () => {
    const { raw, transaction } = fakeDatabase();
    const db = guardSharedClient(raw, () => true);
    const run = vi.fn();
    db.transaction(run);
    expect(transaction).toHaveBeenCalledWith(run);
  });

  it('decides per call, not once: the same client works again after the transaction', () => {
    const { raw } = fakeDatabase();
    let active = true;
    const db = guardSharedClient(raw, () => active);
    expect(() => db.select()).toThrow(InvariantError);
    active = false;
    expect(db.select()).toBe('query');
  });

  it('does not guard anything when the transactional plugin is not registered', () => {
    const { raw } = fakeDatabase();
    expect(guardSharedClient(raw).select()).toBe('query');
  });
});
