import { describe, expect, it } from 'vitest';
import { ApiError } from '@/lib/api/errors';
import { sampleItem } from '@/features/route/fixtures';
import { isStageNotOpen, localUnmet, unmetFromError, unmetText } from './unmet';

const NOW = new Date('2026-06-02T12:00:00Z');
const OPENED_LONG_AGO = { openedAt: '2026-06-01T00:00:00Z' };
const codes = (entries: { code: string }[]) => entries.map((e) => e.code);

function localFor(
  items: ReturnType<typeof sampleItem>[],
  stage: { openedAt: string | null },
  review = new Set<string>(),
) {
  return localUnmet({ stage, items, reviewKeys: review, now: NOW });
}

describe('FR-WORK-10: hint about the unmet conditions', () => {
  it('is empty when required items are done, assigned, reviewed and 24 hours have passed', () => {
    const done = sampleItem({ status: 'done' });
    expect(localFor([done], OPENED_LONG_AGO)).toEqual([]);
  });

  it('flags open required items, a fallback without executor and the 24 hour minimum', () => {
    const open = sampleItem();
    const fallback = sampleItem({
      id: 'f',
      status: 'done',
      fallbackUsed: true,
      assigneeUserId: null,
    });
    const fresh = { openedAt: '2026-06-02T11:00:00Z' };
    expect(codes(localFor([open, fallback], fresh))).toEqual([
      'REQUIRED_ITEMS_OPEN',
      'FALLBACK_ASSIGNEE_MISSING',
      'MIN_TIME_NOT_ELAPSED',
    ]);
  });

  it('ignores optional items and flags a review that has not passed', () => {
    const optional = sampleItem({ required: false });
    expect(localFor([optional], OPENED_LONG_AGO)).toEqual([]);
    const spec = sampleItem({ stepKey: 'mini_spec', status: 'done' });
    expect(codes(localFor([spec], OPENED_LONG_AGO, new Set(['mini_spec'])))).toEqual([
      'REVIEW_NOT_PASSED',
    ]);
    const passed = sampleItem({
      stepKey: 'mini_spec',
      status: 'done',
      review: { answers: [], passed: true },
    });
    expect(localFor([passed], OPENED_LONG_AGO, new Set(['mini_spec']))).toEqual([]);
  });
});

describe('FR-WORK-10: answers of the server', () => {
  function blocked(): ApiError {
    return new ApiError({
      status: 409,
      body: undefined,
      problem: {
        type: 'x',
        title: 'x',
        status: 409,
        code: 'STAGE_TRANSITION_BLOCKED',
        requestId: 'r',
        unmet: [
          { code: 'REQUIRED_ITEMS_OPEN', message: 'server wording' },
          { code: 'BRAND_NEW' as never, message: 'Новое условие' },
        ],
      },
    });
  }

  it('reads unmet[] of STAGE_TRANSITION_BLOCKED and nothing from other errors', () => {
    expect(codes(unmetFromError(blocked()) ?? [])).toEqual(['REQUIRED_ITEMS_OPEN', 'BRAND_NEW']);
    expect(unmetFromError(new ApiError({ status: 409, body: undefined }))).toBeNull();
    expect(unmetFromError(new Error('x'))).toBeNull();
  });

  it('writes known codes in Russian and falls back to the server text for a new code', () => {
    const entries = unmetFromError(blocked()) ?? [];
    expect(unmetText(entries[0]!)).toMatch(/обязательные пункты/);
    expect(unmetText(entries[1]!)).toBe('Новое условие');
    expect(unmetText({ code: 'BRAND_NEW' })).toBe('Не выполнено условие перехода.');
  });

  it('recognises STAGE_NOT_OPEN', () => {
    const error = new ApiError({
      status: 409,
      body: undefined,
      problem: { type: 'x', title: 'x', status: 409, code: 'STAGE_NOT_OPEN', requestId: 'r' },
    });
    expect(isStageNotOpen(error)).toBe(true);
    expect(isStageNotOpen(blocked())).toBe(false);
  });
});
