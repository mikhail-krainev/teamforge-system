import { DomainError, lockTimeoutError } from './domain-error.js';
import { lookupConstraint } from './constraints.js';

export interface PgErrorInfo {
  code: string;
  constraint?: string;
  message?: string;
}

/** Finds the PostgreSQL error inside a (possibly wrapped) driver error. */
export function findPgError(error: unknown): PgErrorInfo | undefined {
  let current: unknown = error;
  for (let depth = 0; depth < 5 && current instanceof Error; depth += 1) {
    const candidate = current as Error & { code?: unknown; constraint_name?: unknown };
    if (typeof candidate.code === 'string' && /^[0-9A-Z]{5}$/.test(candidate.code)) {
      const constraint =
        typeof candidate.constraint_name === 'string' ? candidate.constraint_name : undefined;
      return { code: candidate.code, constraint, message: candidate.message };
    }
    current = current.cause;
  }
  return undefined;
}

export const PG_UNIQUE_VIOLATION = '23505';
export const PG_LOCK_NOT_AVAILABLE = '55P03';
export const PG_DEADLOCK = '40P01';
export const PG_SERIALIZATION_FAILURE = '40001';

export function isRetryableTxError(error: unknown): boolean {
  const code = findPgError(error)?.code;
  return code === PG_DEADLOCK || code === PG_SERIALIZATION_FAILURE;
}

/**
 * Maps database errors to domain errors: 55P03 -> 503 LOCK_TIMEOUT, 23505 -> code by index name.
 * Returns undefined for everything else, including an unknown unique index (programmer error:
 * the caller reports it as 500 and logs it).
 */
export function mapPgError(error: unknown): DomainError | undefined {
  const pg = findPgError(error);
  if (pg === undefined) return undefined;
  if (pg.code === PG_LOCK_NOT_AVAILABLE) return lockTimeoutError();
  if (pg.code === PG_UNIQUE_VIOLATION) {
    const mapping = lookupConstraint(pg.constraint);
    return mapping ? new DomainError(mapping.code, mapping.status) : undefined;
  }
  return undefined;
}
