import { describe, expect, it } from 'vitest';
import type { ErrorCode } from 'shared';
import { ApiError } from '@/lib/api/errors';
import { sampleProfile } from '@/mocks/slice2/db';
import { currentFromConflict, isVersionConflict } from './conflict';

function conflict(current: unknown, code: ErrorCode = 'VERSION_CONFLICT') {
  return new ApiError({
    status: 409,
    body: undefined,
    problem: { status: 409, code, current: current as never },
  });
}

describe('version conflict', () => {
  it('extracts the current profile from problem.current', () => {
    const current = sampleProfile({ version: 4 });
    expect(isVersionConflict(conflict(current))).toBe(true);
    expect(currentFromConflict(conflict(current))?.version).toBe(4);
  });

  it('returns null for other errors and for unusable bodies', () => {
    expect(currentFromConflict(conflict(sampleProfile(), 'INVALID_STATE'))).toBeNull();
    expect(currentFromConflict(conflict({ foo: 1 }))).toBeNull();
    expect(currentFromConflict(conflict(undefined))).toBeNull();
    expect(currentFromConflict(new Error('x'))).toBeNull();
  });
});
