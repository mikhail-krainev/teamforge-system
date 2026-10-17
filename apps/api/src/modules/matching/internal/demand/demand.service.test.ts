import { describe, expect, it, vi } from 'vitest';
import type { RoleDemand } from '../../public.js';
import { DemandService } from './demand.service.js';

const NOW = new Date('2026-01-15T12:00:00Z');

function build() {
  const written: RoleDemand[][] = [];
  const counted: string[][] = [];
  const cache = {
    read: () => Promise.resolve(new Map()),
    write: (rows: RoleDemand[]) => {
      written.push(rows);
      return Promise.resolve();
    },
  };
  const demand = {
    queuedByRole: (roles: string[]) => {
      counted.push(roles);
      return Promise.resolve(new Map());
    },
    waitStatsByRole: () => Promise.resolve(new Map()),
  };
  const teams = { countOpenSeatsByRole: vi.fn(() => Promise.resolve([])) };
  const profiles = {
    listRoles: () =>
      Promise.resolve([
        { code: 'backend', name: 'Backend', active: true },
        { code: 'qa', name: 'QA', active: true },
      ]),
  };
  const service = new DemandService(
    { now: () => NOW } as never,
    cache as never,
    demand as never,
    teams as never,
    profiles as never,
  );
  return { service, written, counted, teams };
}

describe('DemandService.getDemand: only roles of the active catalog reach the cache', () => {
  it('drops unknown roles before counting and before writing cache keys', async () => {
    const { service, written, counted, teams } = build();
    const rows = await service.getDemand(['backend', 'no_such_role', 'qa', 'backend']);
    expect(rows.map((row) => row.roleCode)).toEqual(['backend', 'qa']);
    expect(written.flat().map((row) => row.roleCode)).toEqual(['backend', 'qa']);
    expect(counted).toEqual([['backend', 'qa']]);
    expect(teams.countOpenSeatsByRole).toHaveBeenCalledWith(['backend', 'qa']);
  });

  it('answers an empty list when no requested role is in the catalog, and writes nothing to the cache', async () => {
    const { service, written } = build();
    expect(await service.getDemand(['ghost'])).toEqual([]);
    expect(written.flat()).toEqual([]);
  });
});
