import { describe, expect, it } from 'vitest';
import {
  assignOrdinals,
  changedTeamFields,
  diffSeat,
  expandSeats,
  seatLimitError,
  statusBlock,
} from './team-rules.js';

const seat = (roleCode: string, extra: Record<string, unknown> = {}) => ({
  roleCode,
  desired: false,
  minLevel: 'junior',
  minHours: 10,
  stack: [] as string[],
  ...extra,
});

describe('FR-TEAM-02: seat rules', () => {
  it('expands count copies of each input and de-duplicates the stack', () => {
    const specs = expandSeats([seat('backend', { count: 2, stack: ['ts', 'ts'] }), seat('qa')]);
    expect(specs.map((s) => s.roleCode)).toEqual(['backend', 'backend', 'qa']);
    expect(specs[0]?.stack).toEqual(['ts']);
  });

  it('allows exactly 12 seats (C-04) and refuses the 13th with a pointer', () => {
    expect(seatLimitError(8, 4)).toBeUndefined();
    expect(seatLimitError(12, 0)).toBeUndefined();
    expect(seatLimitError(8, 5)).toMatchObject({ pointer: '/seats', code: 'seat_limit' });
  });

  it('continues ordinals after the highest used per role, closed seats included', () => {
    const specs = expandSeats([seat('backend', { count: 2 }), seat('qa')]);
    expect(assignOrdinals(specs, new Map([['backend', 3]]))).toEqual([4, 5, 1]);
  });
});

describe('FR-TEAM-27: status gates', () => {
  it('blocks finished teams with INVALID_STATE and suspended ones with TEAM_STATUS_BLOCKS_ACTION', () => {
    expect(statusBlock('completed')).toBe('INVALID_STATE');
    expect(statusBlock('archived')).toBe('INVALID_STATE');
    expect(statusBlock('suspended')).toBe('TEAM_STATUS_BLOCKS_ACTION');
    expect(statusBlock('voting')).toBe('TEAM_STATUS_BLOCKS_ACTION');
    for (const status of ['forming', 'active']) {
      expect(statusBlock(status)).toBeUndefined();
    }
  });
});

describe('FR-TEAM-03: seat and team diffs', () => {
  const current = { desired: false, minLevel: 'junior', minHours: 10, stack: ['ts', 'react'] };

  it('reports only values that differ and separates the desired mark from requirements', () => {
    const change = diffSeat(current, { desired: true, minHours: 10, minLevel: 'middle' });
    expect(change.set).toEqual({ desired: true, minLevel: 'middle' });
    expect(change.desiredChanged).toBe(true);
    expect(change.requirementsChanged).toEqual(['minLevel']);
  });

  it('treats a reordered or duplicated stack as unchanged', () => {
    expect(diffSeat(current, { stack: ['react', 'ts', 'ts'] }).requirementsChanged).toEqual([]);
    expect(diffSeat(current, { stack: ['ts'] }).set.stack).toEqual(['ts']);
    expect(diffSeat(current, { minHours: 20 }).requirementsChanged).toEqual(['minHours']);
  });

  it('lists the card fields a patch changes', () => {
    const card = { name: 'A team', description: 'd', timezone: 'UTC', hoursPerWeek: 10 };
    expect(changedTeamFields(card, { name: 'A team', hoursPerWeek: 12 })).toEqual(['hoursPerWeek']);
    expect(changedTeamFields(card, {})).toEqual([]);
  });
});
