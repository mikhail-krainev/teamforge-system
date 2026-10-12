import { describe, expect, it } from 'vitest';
import { DomainError } from '../errors/domain-error.js';
import { buildPage, clampLimit, decodeCursor, encodeCursor, filterHash } from './pagination.js';

describe('cursor pagination', () => {
  const filters = { status: 'open', role: 'backend' };

  it('round-trips a cursor for the same filters', () => {
    const cursor = encodeCursor(['2026-01-01T00:00:00Z', 'id-1'], filters);
    expect(decodeCursor(cursor, { role: 'backend', status: 'open' }).k).toEqual([
      '2026-01-01T00:00:00Z',
      'id-1',
    ]);
  });

  it('uses a base64url JSON envelope with version 1', () => {
    const cursor = encodeCursor([5], filters);
    expect(cursor).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(JSON.parse(Buffer.from(cursor, 'base64url').toString())).toMatchObject({ v: 1, k: [5] });
  });

  it('rejects a cursor made for another filter set with 400', () => {
    const cursor = encodeCursor([1], filters);
    expect(() => decodeCursor(cursor, { status: 'closed', role: 'backend' })).toThrow(DomainError);
    try {
      decodeCursor(cursor, {});
    } catch (error) {
      expect(error).toMatchObject({ status: 400, code: 'VALIDATION_FAILED' });
    }
  });

  it.each(['', 'not-base64-json', Buffer.from('{"v":2}').toString('base64url')])(
    'rejects malformed cursor %j',
    (cursor) => {
      expect(() => decodeCursor(cursor, filters)).toThrow(DomainError);
    },
  );

  it('ignores undefined filters and key order when hashing', () => {
    expect(filterHash({ a: 1, b: undefined })).toBe(filterHash({ a: 1 }));
    expect(filterHash({ a: 1, b: 2 })).not.toBe(filterHash({ a: 2, b: 1 }));
  });

  it('builds pages from limit + 1 rows', () => {
    const rows = [1, 2, 3, 4];
    const page = buildPage(rows, 3, (n) => [n], filters);
    expect(page.items).toEqual([1, 2, 3]);
    expect(decodeCursor(page.nextCursor ?? '', filters).k).toEqual([3]);
    expect(buildPage([1, 2], 3, (n) => [n], filters).nextCursor).toBeNull();
  });

  it('applies the limit bounds 1..100 with default 20', () => {
    expect(clampLimit(undefined)).toBe(20);
    expect(clampLimit(100)).toBe(100);
    expect(() => clampLimit(0)).toThrow(DomainError);
    expect(() => clampLimit(101)).toThrow(DomainError);
  });
});
