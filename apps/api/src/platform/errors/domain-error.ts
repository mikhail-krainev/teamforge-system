import type { ErrorCode } from 'shared';

export interface FieldError {
  pointer: string;
  code?: string;
  message: string;
}

export interface UnmetCondition {
  code: string;
  message: string;
  data?: Record<string, unknown>;
}

/** Optional parts of the problem+json body (architecture 13.1). */
export interface DomainErrorData {
  detail?: string;
  errors?: FieldError[];
  unmet?: UnmetCondition[];
  current?: Record<string, unknown>;
  retryAfterSeconds?: number;
  /** Extra response headers (Retry-After, RateLimit-*). */
  headers?: Record<string, string>;
}

/** Expected business failure. Mapped to application/problem+json by ProblemFilter. */
export class DomainError extends Error {
  constructor(
    readonly code: ErrorCode,
    readonly status: number,
    readonly data: DomainErrorData = {},
  ) {
    super(`${code}: ${data.detail ?? ''}`.trim());
    this.name = 'DomainError';
  }
}

/** Raised for programmer errors (violated invariants); never shown to users, maps to 500. */
export class InvariantError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvariantError';
  }
}

export function lockTimeoutError(): DomainError {
  return new DomainError('LOCK_TIMEOUT', 503, {
    retryAfterSeconds: 1,
    headers: { 'Retry-After': '1' },
  });
}

/**
 * Carries a stored idempotent response. Thrown by IdempotencyInterceptor on replay and written
 * verbatim by ProblemFilter (Nest would otherwise overwrite the status with the handler default).
 */
export class IdempotentReplay extends Error {
  constructor(
    readonly status: number,
    readonly body: unknown,
  ) {
    super('idempotent replay');
    this.name = 'IdempotentReplay';
  }
}
