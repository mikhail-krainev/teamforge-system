import type { ErrorCode } from 'shared';
import { describe, expect, it } from 'vitest';
import { describeError, invalidFields, retryAfterOf } from './error-message';
import { ApiError, NetworkError, type Problem } from './errors';

function apiError(
  status: number,
  code: ErrorCode,
  extra: { retryAfterSeconds?: number; problem?: Problem } = {},
) {
  return new ApiError({
    status,
    body: undefined,
    problem: { status, code, ...extra.problem },
    retryAfterSeconds: extra.retryAfterSeconds,
  });
}

describe('describeError', () => {
  it('maps known codes to Russian text', () => {
    expect(describeError(apiError(401, 'INVALID_TOKEN'))).toContain('недействительна');
  });

  it('adds the Retry-After wait to a 429, with Russian plural forms', () => {
    const text = (seconds: number) =>
      describeError(apiError(429, 'RATE_LIMITED', { retryAfterSeconds: seconds }));
    expect(text(30)).toContain('30 секунд');
    expect(text(2)).toContain('2 секунды');
    expect(text(1)).toContain('1 секунду');
  });

  it('handles network and unknown failures without leaking details', () => {
    expect(describeError(new NetworkError())).toContain('Нет связи');
    expect(describeError(new Error('secret stack'))).not.toContain('secret');
    expect(describeError(apiError(500, 'FILE_TOO_SMALL'))).toContain('слишком маленький');
  });
});

describe('retryAfterOf / invalidFields', () => {
  it('prefers the header over the problem body', () => {
    const error = apiError(429, 'RATE_LIMITED', {
      retryAfterSeconds: 5,
      problem: { retryAfterSeconds: 9 },
    });
    expect(retryAfterOf(error)).toBe(5);
  });

  it('lists rejected fields by their first pointer segment', () => {
    const error = apiError(422, 'VALIDATION_FAILED', {
      problem: {
        errors: [
          { pointer: '/email', message: 'x' },
          { pointer: '/stack/2', message: 'y' },
        ],
      },
    });
    expect([...invalidFields(error)]).toEqual(['email', 'stack']);
  });
});
