import { HttpException } from '@nestjs/common';
import type { ErrorCode } from 'shared';
import { DomainError } from './domain-error.js';
import { mapPgError } from './pg-errors.js';
import { titleFor } from './titles.js';

export interface ProblemContext {
  instance: string;
  requestId: string;
}

export interface ProblemResult {
  status: number;
  body: Record<string, unknown>;
  headers: Record<string, string>;
  /** True when the error was not an expected business/HTTP error (log at error level). */
  unexpected: boolean;
}

const CODE_BY_STATUS: Record<number, ErrorCode> = {
  400: 'VALIDATION_FAILED',
  401: 'UNAUTHENTICATED',
  403: 'FORBIDDEN',
  404: 'NOT_FOUND',
  429: 'RATE_LIMITED',
};

export function problemTypeFor(code: ErrorCode): string {
  return `https://teamforge.ru/problems/${code.toLowerCase().replaceAll('_', '-')}`;
}

function httpStatusOf(error: unknown): number | undefined {
  if (error instanceof HttpException) return error.getStatus();
  const candidate = (error as { statusCode?: unknown } | null)?.statusCode;
  return typeof candidate === 'number' && candidate >= 400 && candidate < 500
    ? candidate
    : undefined;
}

function classify(error: unknown): { domain: DomainError; unexpected: boolean } {
  if (error instanceof DomainError) return { domain: error, unexpected: error.status >= 500 };
  const fromPg = mapPgError(error);
  if (fromPg) return { domain: fromPg, unexpected: false };
  const status = httpStatusOf(error);
  if (status !== undefined) {
    const code = CODE_BY_STATUS[status] ?? 'VALIDATION_FAILED';
    return { domain: new DomainError(code, status), unexpected: false };
  }
  return { domain: new DomainError('INTERNAL', 500), unexpected: true };
}

/** Converts any thrown value to a problem+json body (RFC 9457, architecture 13.1). */
export function toProblem(error: unknown, ctx: ProblemContext): ProblemResult {
  const { domain, unexpected } = classify(error);
  const { detail, errors, unmet, current, retryAfterSeconds, headers } = domain.data;
  const body: Record<string, unknown> = {
    type: problemTypeFor(domain.code),
    title: titleFor(domain.code, domain.status),
    status: domain.status,
    code: domain.code,
    instance: ctx.instance,
    requestId: ctx.requestId,
  };
  if (detail !== undefined) body.detail = detail;
  if (errors !== undefined) body.errors = errors;
  if (unmet !== undefined) body.unmet = unmet;
  if (current !== undefined) body.current = current;
  if (retryAfterSeconds !== undefined) body.retryAfterSeconds = retryAfterSeconds;
  return { status: domain.status, body, headers: headers ?? {}, unexpected };
}
