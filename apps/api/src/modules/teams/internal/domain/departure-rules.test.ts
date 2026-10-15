import { describe, expect, it } from 'vitest';
import {
  DEPARTURE_DEFAULT_MS,
  decisionPointerError,
  departureDueAt,
  departureOverdue,
} from './departure-rules.js';

describe('departure rules (FR-TEAM-12, C-14)', () => {
  it('is due 7 days after the leave', () => {
    const left = new Date('2026-03-01T10:00:00Z');
    expect(departureDueAt(left).toISOString()).toBe('2026-03-08T10:00:00.000Z');
    expect(DEPARTURE_DEFAULT_MS).toBe(7 * 86_400_000);
  });

  it('is overdue exactly at the due time and after, not before', () => {
    const due = new Date('2026-03-08T10:00:00Z');
    expect(departureOverdue(due, new Date(due.getTime() - 1))).toBe(false);
    expect(departureOverdue(due, due)).toBe(true);
    expect(departureOverdue(due, new Date(due.getTime() + 1))).toBe(true);
  });

  it('accepts "replace" without seats and "continue" with or without seats of the departure', () => {
    expect(decisionPointerError({ decision: 'replace' }, ['a'])).toBeUndefined();
    expect(decisionPointerError({ decision: 'continue' }, ['a'])).toBeUndefined();
    expect(decisionPointerError({ decision: 'continue', closeSeatIds: ['a'] }, ['a', 'b'])).toBe(
      undefined,
    );
  });

  it('refuses closeSeatIds with "replace" and seats of another departure', () => {
    expect(decisionPointerError({ decision: 'replace', closeSeatIds: ['a'] }, ['a'])).toBe(
      '/closeSeatIds',
    );
    expect(decisionPointerError({ decision: 'continue', closeSeatIds: ['z'] }, ['a'])).toBe(
      '/closeSeatIds',
    );
  });
});
