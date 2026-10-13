import { describe, expect, it } from 'vitest';
import {
  MAX_PROJECT_DAYS,
  TEAM_STATUSES,
  canTransition,
  maxDurationReached,
  plannedEnd,
  startError,
  statusBlock,
  transitionError,
} from './team-status.js';

const DAY = 86_400_000;
const T0 = new Date('2026-01-01T00:00:00Z');

describe('FR-TEAM-27: team status machine', () => {
  it('allows exactly the edges of the diagram', () => {
    const allowed: [string, string][] = [
      ['forming', 'active'],
      ['forming', 'voting'],
      ['forming', 'suspended'],
      ['forming', 'archived'],
      ['active', 'voting'],
      ['active', 'suspended'],
      ['active', 'completed'],
      ['voting', 'forming'],
      ['voting', 'active'],
      ['voting', 'suspended'],
      ['voting', 'archived'],
      ['suspended', 'forming'],
      ['suspended', 'active'],
      ['suspended', 'voting'],
      ['suspended', 'archived'],
      ['completed', 'archived'],
    ];
    for (const from of TEAM_STATUSES) {
      for (const to of TEAM_STATUSES) {
        const expected = allowed.some(([a, b]) => a === from && b === to);
        expect(canTransition(from, to), `${from} -> ${to}`).toBe(expected);
        expect(transitionError(from, to)).toBe(expected ? undefined : 'INVALID_STATE');
      }
    }
  });

  it('refuses unknown statuses and leaving archived', () => {
    expect(canTransition('nonsense', 'active')).toBe(false);
    expect(canTransition('active', 'nonsense')).toBe(false);
    for (const to of TEAM_STATUSES) expect(canTransition('archived', to)).toBe(false);
  });

  it('blocks lead actions: voting/suspended -> TEAM_STATUS_BLOCKS_ACTION, finished -> INVALID_STATE', () => {
    expect(statusBlock('voting')).toBe('TEAM_STATUS_BLOCKS_ACTION');
    expect(statusBlock('suspended')).toBe('TEAM_STATUS_BLOCKS_ACTION');
    expect(statusBlock('completed')).toBe('INVALID_STATE');
    expect(statusBlock('archived')).toBe('INVALID_STATE');
    expect(statusBlock('forming')).toBeUndefined();
    expect(statusBlock('active')).toBeUndefined();
  });

  it('FR-TEAM-10: only a forming team can start', () => {
    expect(startError('forming')).toBeUndefined();
    expect(startError('active')).toBe('INVALID_STATE');
    expect(startError('voting')).toBe('TEAM_STATUS_BLOCKS_ACTION');
    expect(startError('suspended')).toBe('TEAM_STATUS_BLOCKS_ACTION');
    expect(startError('completed')).toBe('INVALID_STATE');
  });

  it('plans the end by the playbook length, never beyond 120 days (C-06)', () => {
    expect(plannedEnd(T0, 84).getTime()).toBe(T0.getTime() + 84 * DAY);
    expect(plannedEnd(T0, 400).getTime()).toBe(T0.getTime() + MAX_PROJECT_DAYS * DAY);
    expect(plannedEnd(T0, null).getTime()).toBe(T0.getTime() + MAX_PROJECT_DAYS * DAY);
  });

  it('C-06: the limit is 120 days from the start, shifted by the time spent suspended', () => {
    const active = { status: 'active', startedAt: T0, suspendedTotalSeconds: 0 };
    expect(maxDurationReached(active, new Date(T0.getTime() + 119 * DAY))).toBe(false);
    expect(maxDurationReached(active, new Date(T0.getTime() + 120 * DAY))).toBe(true);
    const shifted = { ...active, suspendedTotalSeconds: 10 * 86_400 };
    expect(maxDurationReached(shifted, new Date(T0.getTime() + 125 * DAY))).toBe(false);
    expect(maxDurationReached(shifted, new Date(T0.getTime() + 130 * DAY))).toBe(true);
  });

  it('C-06: only an active, started team can run out of time', () => {
    const late = new Date(T0.getTime() + 500 * DAY);
    expect(
      maxDurationReached({ status: 'forming', startedAt: null, suspendedTotalSeconds: 0 }, late),
    ).toBe(false);
    expect(
      maxDurationReached({ status: 'active', startedAt: null, suspendedTotalSeconds: 0 }, late),
    ).toBe(false);
    expect(
      maxDurationReached({ status: 'suspended', startedAt: T0, suspendedTotalSeconds: 0 }, late),
    ).toBe(false);
  });
});
