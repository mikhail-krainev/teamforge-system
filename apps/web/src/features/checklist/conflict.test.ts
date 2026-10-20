import { describe, expect, it } from 'vitest';
import { ApiError } from '@/lib/api/errors';
import { conflictRows, currentFromConflict, isVersionConflict } from './conflict';
import { sampleItem } from '@/features/route/fixtures';

function conflictError(current: unknown): ApiError {
  return new ApiError({
    status: 409,
    body: undefined,
    problem: {
      type: 'x',
      title: 'x',
      status: 409,
      code: 'VERSION_CONFLICT',
      requestId: 'r',
      current: current as Record<string, never>,
    },
  });
}

describe('FR-WORK-07: version conflict of a checklist item', () => {
  it('recognises VERSION_CONFLICT only', () => {
    expect(isVersionConflict(conflictError({}))).toBe(true);
    expect(isVersionConflict(new ApiError({ status: 409, body: undefined }))).toBe(false);
    expect(isVersionConflict(new Error('x'))).toBe(false);
  });

  it('takes the current item from the problem when it looks like an item', () => {
    const current = sampleItem({ version: 9 });
    expect(currentFromConflict(conflictError(current))?.version).toBe(9);
    expect(currentFromConflict(conflictError({ version: 'x' }))).toBeNull();
    expect(currentFromConflict(conflictError(undefined))).toBeNull();
  });

  it('lists the user fields next to the actual values, and no rows for non-patch writes', () => {
    const actual = sampleItem({ outcome: 'Итоги Бориса', status: 'done' });
    const rows = conflictRows(
      { kind: 'patch', patch: { outcome: 'Итоги Кирилла', status: 'open' } },
      actual,
    );
    expect(rows).toEqual([
      { field: 'Итоги', mine: 'Итоги Кирилла', actual: 'Итоги Бориса' },
      { field: 'Статус', mine: 'Не выполнен', actual: 'Выполнен' },
    ]);
    expect(conflictRows({ kind: 'assign', userId: 'u' }, actual)).toEqual([]);
  });

  it('shows an empty actual value as "(пусто)"', () => {
    const rows = conflictRows(
      { kind: 'patch', patch: { linkUrl: 'https://a.example' } },
      sampleItem(),
    );
    expect(rows[0]?.actual).toBe('(пусто)');
  });
});
