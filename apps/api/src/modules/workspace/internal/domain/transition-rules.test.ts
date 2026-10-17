import { describe, expect, it } from 'vitest';
import {
  MIN_STAGE_MS,
  nextOrdinal,
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
