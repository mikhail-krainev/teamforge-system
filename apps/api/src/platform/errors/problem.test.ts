import { HttpException } from '@nestjs/common';
import { describe, expect, it } from 'vitest';
import { registerConstraint, lookupConstraint } from './constraints.js';
import { DomainError } from './domain-error.js';
import { findPgError, isRetryableTxError, mapPgError } from './pg-errors.js';
import { toProblem } from './problem.js';

const ctx = { instance: '/v1/example/{id}', requestId: 'req-12345678' };

function pgError(code: string, constraint?: string): Error {
  return Object.assign(new Error('pg'), { code, constraint_name: constraint });
}

describe('toProblem', () => {
  it('renders a DomainError with RFC 9457 fields and requestId', () => {
    const problem = toProblem(
      new DomainError('SEAT_TAKEN', 409, { detail: 'taken', retryAfterSeconds: 0 }),
      ctx,
    );
    expect(problem.status).toBe(409);
    expect(problem.body).toMatchObject({
      type: 'https://teamforge.ru/problems/seat-taken',
      status: 409,
      code: 'SEAT_TAKEN',
      instance: '/v1/example/{id}',
      requestId: 'req-12345678',
      detail: 'taken',
    });
    expect(typeof problem.body.title).toBe('string');
    expect(problem.unexpected).toBe(false);
  });

  it('maps HTTP exceptions by status', () => {
    const notFound = toProblem(new HttpException('x', 404), ctx);
    expect(notFound.body).toMatchObject({ status: 404, code: 'NOT_FOUND' });
    const bad = toProblem(Object.assign(new Error('bad json'), { statusCode: 400 }), ctx);
    expect(bad.body).toMatchObject({ status: 400, code: 'VALIDATION_FAILED' });
  });

  it('hides details of unknown errors behind INTERNAL 500', () => {
    const problem = toProblem(new Error('secret db detail'), ctx);
    expect(problem).toMatchObject({ status: 500, unexpected: true });
    expect(JSON.stringify(problem.body)).not.toContain('secret');
    expect(problem.body.code).toBe('INTERNAL');
  });

  it('maps 55P03 to 503 LOCK_TIMEOUT with Retry-After', () => {
    const problem = toProblem(pgError('55P03'), ctx);
    expect(problem).toMatchObject({ status: 503, headers: { 'Retry-After': '1' } });
    expect(problem.body.code).toBe('LOCK_TIMEOUT');
  });

  it('maps 23505 by constraint name and treats unknown names as INTERNAL', () => {
    const known = toProblem(pgError('23505', 'seat_assignment_active_seat_uq'), ctx);
    expect(known.body).toMatchObject({ status: 409, code: 'SEAT_TAKEN' });
    const unknown = toProblem(pgError('23505', 'some_new_uq'), ctx);
    expect(unknown).toMatchObject({ status: 500, unexpected: true });
  });

  it('finds the PostgreSQL error inside a wrapped driver error', () => {
    const wrapped = new Error('Failed query', { cause: pgError('40P01') });
    expect(findPgError(wrapped)?.code).toBe('40P01');
    expect(isRetryableTxError(wrapped)).toBe(true);
    expect(mapPgError(wrapped)).toBeUndefined();
  });
});

describe('constraint registry', () => {
  it('registers new mappings and rejects conflicting redefinitions', () => {
    registerConstraint('example_unit_uq', { code: 'REPO_TAKEN', status: 409 });
    expect(lookupConstraint('example_unit_uq')?.code).toBe('REPO_TAKEN');
    expect(() =>
      registerConstraint('example_unit_uq', { code: 'SEAT_TAKEN', status: 409 }),
    ).toThrow();
  });
});
