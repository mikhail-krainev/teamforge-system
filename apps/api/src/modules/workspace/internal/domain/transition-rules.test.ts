import { describe, expect, it } from 'vitest';
import {
  MIN_STAGE_MS,
  nextOrdinal,
  STAGE_DUE_SOON_MS,
  stageDuePhase,
  unmetConditions,
  type TransitionItem,
} from './transition-rules.js';

const OPENED = new Date('2026-01-01T00:00:00Z');
const AFTER = new Date(OPENED.getTime() + MIN_STAGE_MS);
const item = (over: Partial<TransitionItem>): TransitionItem => ({
  id: 'i1',
  stepKey: 'a',
  required: true,
  status: 'done',
  fallbackUsed: false,
  assigneeUserId: 'u1',
  ...over,
});
const codes = (facts: Parameters<typeof unmetConditions>[0]): string[] =>
  unmetConditions(facts).map((u) => u.code);

describe('unmetConditions (FR-WORK-10)', () => {
  it('nothing is unmet when required items are done, reviewed and 24 h passed', () => {
    expect(
      codes({
        items: [item({}), item({ id: 'i2', required: false, status: 'open' })],
        unpassedStepKeys: [],
        openedAt: OPENED,
        now: AFTER,
      }),
    ).toEqual([]);
  });

  it('lists every unmet condition with the items that cause it', () => {
    const unmet = unmetConditions({
      items: [item({ status: 'open', fallbackUsed: true, assigneeUserId: null })],
      unpassedStepKeys: ['b'],
      openedAt: OPENED,
      now: OPENED,
    });
    expect(unmet.map((u) => u.code)).toEqual([
      'REQUIRED_ITEMS_OPEN',
      'FALLBACK_ASSIGNEE_MISSING',
      'REVIEW_NOT_PASSED',
      'MIN_TIME_NOT_ELAPSED',
    ]);
    expect(unmet[0]?.data).toMatchObject({ itemIds: ['i1'] });
  });

  it('FR-PLAY-08: a blocking automatic check that failed is AUTO_CHECKS_FAILED, last, with the items and the checks', () => {
    const unmet = unmetConditions({
      items: [item({})],
      unpassedStepKeys: ['b'],
      autoCheckFailures: [{ itemId: 'i1', stepKey: 'a', checks: ['link_https'] }],
      openedAt: OPENED,
      now: OPENED,
    });
    expect(unmet.map((u) => u.code)).toEqual([
      'REVIEW_NOT_PASSED',
      'MIN_TIME_NOT_ELAPSED',
      'AUTO_CHECKS_FAILED',
    ]);
    expect(unmet.at(-1)?.data).toEqual({
      itemIds: ['i1'],
      stepKeys: ['a'],
      checks: { a: ['link_https'] },
    });
  });

  it('no failures, no AUTO_CHECKS_FAILED', () => {
    expect(
      codes({
        items: [item({})],
        unpassedStepKeys: [],
        autoCheckFailures: [],
        openedAt: OPENED,
        now: AFTER,
      }),
    ).toEqual([]);
  });

  it('one millisecond short of 24 hours is still too early', () => {
    expect(
      codes({
        items: [],
        unpassedStepKeys: [],
        openedAt: OPENED,
        now: new Date(AFTER.getTime() - 1),
      }),
    ).toEqual(['MIN_TIME_NOT_ELAPSED']);
  });
});

describe('nextOrdinal', () => {
  it('takes the next greater ordinal and none after the last', () => {
    expect(nextOrdinal([3, 1, 2], 1)).toBe(2);
    expect(nextOrdinal([1, 2, 3], 3)).toBeUndefined();
  });
});

describe('stageDuePhase (FR-WORK-18, -19)', () => {
  const due = new Date('2026-01-08T00:00:00Z');
  it('is soon within a day, overdue after, silent before and while suspended', () => {
    expect(stageDuePhase(due, new Date('2026-01-07T12:00:00Z'), 'active')).toBe('soon');
    expect(stageDuePhase(due, new Date('2026-01-08T00:00:01Z'), 'active')).toBe('overdue');
    expect(stageDuePhase(due, new Date('2026-01-05T00:00:00Z'), 'active')).toBeNull();
    expect(stageDuePhase(due, new Date('2026-01-09T00:00:00Z'), 'suspended')).toBeNull();
  });
});

describe('unmetConditions: edges found while implementing S5-08, S5-09 (S5-14)', () => {
  it('exactly 24 hours is enough; a stage that has no opening time is never ready and names no earliest time', () => {
    expect(codes({ items: [], unpassedStepKeys: [], openedAt: OPENED, now: AFTER })).toEqual([]);
    const unmet = unmetConditions({ items: [], unpassedStepKeys: [], openedAt: null, now: AFTER });
    expect(unmet.map((u) => u.code)).toEqual(['MIN_TIME_NOT_ELAPSED']);
    expect(unmet[0]?.data).toEqual({ earliestAt: null });
  });

  it('MIN_TIME_NOT_ELAPSED names the moment the stage may close: the opening plus 24 hours', () => {
    const unmet = unmetConditions({
      items: [],
      unpassedStepKeys: [],
      openedAt: OPENED,
      now: new Date(OPENED.getTime() + 3_600_000),
    });
    expect(unmet[0]?.data).toEqual({ earliestAt: AFTER.toISOString() });
  });

  it('a clock that is before the opening (skew) is still "too early", not an error', () => {
    expect(
      codes({
        items: [],
        unpassedStepKeys: [],
        openedAt: OPENED,
        now: new Date(OPENED.getTime() - 60_000),
      }),
    ).toEqual(['MIN_TIME_NOT_ELAPSED']);
  });

  it('an optional item that is open blocks nothing, and neither does its fallback without an executor', () => {
    expect(
      codes({
        items: [
          item({ id: 'o1', required: false, status: 'open' }),
          item({
            id: 'o2',
            required: false,
            status: 'open',
            fallbackUsed: true,
            assigneeUserId: null,
          }),
        ],
        unpassedStepKeys: [],
        openedAt: OPENED,
        now: AFTER,
      }),
    ).toEqual([]);
  });

  it('a fallback step with an executor is only "open"; one that is done without an executor is not an orphan', () => {
    const unmet = unmetConditions({
      items: [
        item({ id: 'f1', stepKey: 'f1', status: 'open', fallbackUsed: true, assigneeUserId: 'u2' }),
        item({ id: 'f2', stepKey: 'f2', status: 'done', fallbackUsed: true, assigneeUserId: null }),
      ],
      unpassedStepKeys: [],
      openedAt: OPENED,
      now: AFTER,
    });
    expect(unmet.map((u) => u.code)).toEqual(['REQUIRED_ITEMS_OPEN']);
    expect(unmet[0]?.data).toEqual({ itemIds: ['f1'], stepKeys: ['f1'] });
  });

  it('REVIEW_NOT_PASSED names the required items of those steps only: an optional item of the same step key is not listed, an unpassed step with no required item adds no item', () => {
    const unmet = unmetConditions({
      items: [
        item({ id: 'r1', stepKey: 'spec' }),
        item({ id: 'r2', stepKey: 'spec', required: false }),
        item({ id: 'r3', stepKey: 'other' }),
      ],
      unpassedStepKeys: ['spec'],
      openedAt: OPENED,
      now: AFTER,
    });
    expect(unmet).toHaveLength(1);
    expect(unmet[0]).toMatchObject({
      code: 'REVIEW_NOT_PASSED',
      data: { itemIds: ['r1'], stepKeys: ['spec'] },
    });
  });

  it('all five conditions at once come in the order of the contract UnmetCode, each exactly once', () => {
    const unmet = unmetConditions({
      items: [
        item({ id: 'a', stepKey: 'a', status: 'open', fallbackUsed: true, assigneeUserId: null }),
        item({ id: 'b', stepKey: 'b' }),
      ],
      unpassedStepKeys: ['b'],
      autoCheckFailures: [{ itemId: 'b', stepKey: 'b', checks: ['file_ok', 'link_https'] }],
      openedAt: OPENED,
      now: OPENED,
    });
    expect(unmet.map((u) => u.code)).toEqual([
      'REQUIRED_ITEMS_OPEN',
      'FALLBACK_ASSIGNEE_MISSING',
      'REVIEW_NOT_PASSED',
      'MIN_TIME_NOT_ELAPSED',
      'AUTO_CHECKS_FAILED',
    ]);
    expect(unmet.at(-1)?.data).toEqual({
      itemIds: ['b'],
      stepKeys: ['b'],
      checks: { b: ['file_ok', 'link_https'] },
    });
  });

  it('AUTO_CHECKS_FAILED lists every failing item and keeps the checks of each step apart', () => {
    const unmet = unmetConditions({
      items: [item({ id: 'a', stepKey: 'a' }), item({ id: 'b', stepKey: 'b' })],
      unpassedStepKeys: [],
      autoCheckFailures: [
        { itemId: 'a', stepKey: 'a', checks: ['link_https'] },
        { itemId: 'b', stepKey: 'b', checks: ['file_ok'] },
      ],
      openedAt: OPENED,
      now: AFTER,
    });
    expect(unmet).toHaveLength(1);
    expect(unmet[0]?.data).toEqual({
      itemIds: ['a', 'b'],
      stepKeys: ['a', 'b'],
      checks: { a: ['link_https'], b: ['file_ok'] },
    });
  });
});

describe('nextOrdinal and stageDuePhase: edges (S5-14)', () => {
  it('the next ordinal skips gaps and ignores the stage itself and every lower one', () => {
    expect(nextOrdinal([1, 2, 5], 2)).toBe(5);
    expect(nextOrdinal([1, 2, 5], 0)).toBe(1);
    expect(nextOrdinal([], 1)).toBeUndefined();
    expect(nextOrdinal([2], 2)).toBeUndefined();
  });

  it('the moment of the deadline is already overdue; exactly 24 hours before it is "soon"; a team that is voting still gets the reminder', () => {
    const due = new Date('2026-01-08T00:00:00Z');
    expect(stageDuePhase(due, due, 'active')).toBe('overdue');
    expect(stageDuePhase(due, new Date(due.getTime() - STAGE_DUE_SOON_MS), 'active')).toBe('soon');
    expect(
      stageDuePhase(due, new Date(due.getTime() - STAGE_DUE_SOON_MS - 1), 'active'),
    ).toBeNull();
    expect(stageDuePhase(due, new Date('2026-01-07T12:00:00Z'), 'voting')).toBe('soon');
  });

  it('a suspended team is frozen even when the stage is already overdue', () => {
    expect(
      stageDuePhase(
        new Date('2026-01-01T00:00:00Z'),
        new Date('2026-02-01T00:00:00Z'),
        'suspended',
      ),
    ).toBeNull();
  });
});
