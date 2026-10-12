import { createHash } from 'node:crypto';
import { DomainError } from '../errors/domain-error.js';
import { canonicalJson } from '../http/canonical-json.js';

/** Keyset cursor payload: `{v:1, k:[...sort key values], f:<filter hash>}` as base64url JSON. */
export interface CursorPayload {
  v: 1;
  k: Array<string | number | null>;
  f: string;
}

export const DEFAULT_PAGE_LIMIT = 20;
export const MAX_PAGE_LIMIT = 100;

/** Stable hash of the filter set; a cursor is only valid for the filters it was created with. */
export function filterHash(filters: Record<string, unknown>): string {
  const json = canonicalJson(filters);
  return createHash('sha256').update(json).digest('hex').slice(0, 16);
}

export function encodeCursor(key: CursorPayload['k'], filters: Record<string, unknown>): string {
  const payload: CursorPayload = { v: 1, k: key, f: filterHash(filters) };
  return Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
}

function invalidCursor(): DomainError {
  return new DomainError('VALIDATION_FAILED', 400, {
    errors: [{ pointer: '/cursor', code: 'invalid_cursor', message: 'Invalid cursor' }],
  });
}

function isKeyValue(value: unknown): value is string | number | null {
  return value === null || typeof value === 'string' || typeof value === 'number';
}

/** Decodes a cursor; 400 for malformed input or a cursor made for a different filter set. */
export function decodeCursor(cursor: string, filters: Record<string, unknown>): CursorPayload {
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
  } catch {
    throw invalidCursor();
  }
  const candidate = parsed as Partial<CursorPayload> | null;
  const valid =
    candidate !== null &&
    typeof candidate === 'object' &&
    candidate.v === 1 &&
    typeof candidate.f === 'string' &&
    Array.isArray(candidate.k) &&
    candidate.k.length > 0 &&
    candidate.k.every(isKeyValue);
  if (!valid || candidate.f !== filterHash(filters)) throw invalidCursor();
  return candidate as CursorPayload;
}

export function clampLimit(limit: number | undefined): number {
  if (limit === undefined) return DEFAULT_PAGE_LIMIT;
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_PAGE_LIMIT) {
    throw new DomainError('VALIDATION_FAILED', 400, {
      errors: [{ pointer: '/limit', code: 'out_of_range', message: 'limit must be 1..100' }],
    });
  }
  return limit;
}

export interface Page<T> {
  items: T[];
  nextCursor: string | null;
}

/**
 * Builds a page from rows fetched with `LIMIT limit + 1`: the extra row only signals that a next
 * page exists and is dropped. `keyOf` returns the sort key values of the last returned row.
 */
export function buildPage<T>(
  rows: T[],
  limit: number,
  keyOf: (row: T) => CursorPayload['k'],
  filters: Record<string, unknown>,
): Page<T> {
  const items = rows.slice(0, limit);
  const last = items.at(-1);
  const hasMore = rows.length > limit && last !== undefined;
  return { items, nextCursor: hasMore ? encodeCursor(keyOf(last), filters) : null };
}
