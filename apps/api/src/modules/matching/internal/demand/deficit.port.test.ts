import type { ModuleRef } from '@nestjs/core';
import { describe, expect, it } from 'vitest';
import type { DeficitPort, TeamsApi } from '../../../teams/public.js';
import { MatchingDeficitPort } from './deficit.port.js';
import type { DemandRepository } from './demand.repository.js';

function make(openSeats: number, queued: number): { port: DeficitPort; excluded: unknown[] } {
  const excluded: unknown[] = [];
  const teams = {
    countOpenSeatsByRole: (roles: string[]) =>
      Promise.resolve(
        openSeats === 0 ? [] : [{ roleCode: roles[0] ?? '', openSeats, teamsSeeking: 1 }],
      ),
  } as unknown as TeamsApi;
  const demand = {
    queuedForRole: (_role: string, exclude: string | undefined) => {
      excluded.push(exclude);
      return Promise.resolve(queued);
    },
  } as unknown as DemandRepository;
  return {
    port: new MatchingDeficitPort({ get: () => teams } as unknown as ModuleRef, demand),
    excluded,
  };
}

/** The contract of the slice 3 stub, kept by the real implementation (stub-ports.test.ts). */
function deficitPortContract(makePort: () => DeficitPort): void {
  it('reports a count of open seats, a non-negative queue and a boolean verdict', async () => {
    const result = await makePort().evaluate({
      roleCode: 'backend',
      openSeats: 0,
      joiningUserId: 'u1',
      via: 'offer',
    });
    expect(result.openSeats).toBeGreaterThanOrEqual(0);
    expect(result.queued).toBeGreaterThanOrEqual(0);
    expect(typeof result.deficit).toBe('boolean');
  });
}

describe('DeficitPort (matching)', () => {
  deficitPortContract(() => make(2, 1).port);

  it('is a deficit when open seats are strictly more than the queue', async () => {
    const input = { roleCode: 'qa', openSeats: 0, joiningUserId: 'u1', via: 'offer' } as const;
    await expect(make(3, 1).port.evaluate(input)).resolves.toEqual({
      deficit: true,
      openSeats: 3,
      queued: 1,
    });
    await expect(make(1, 1).port.evaluate(input)).resolves.toMatchObject({ deficit: false });
    await expect(make(1, 2).port.evaluate(input)).resolves.toMatchObject({ deficit: false });
  });

  it('leaves the joiner out of the queue for invite, offer and request, not for auto', async () => {
    for (const via of ['invite', 'offer', 'request'] as const) {
      const { port, excluded } = make(1, 0);
      await port.evaluate({ roleCode: 'qa', openSeats: 0, joiningUserId: 'u1', via });
      expect(excluded).toEqual(['u1']);
    }
    const { port, excluded } = make(1, 1);
    await port.evaluate({ roleCode: 'qa', openSeats: 0, joiningUserId: 'u1', via: 'auto' });
    expect(excluded).toEqual([undefined]);
  });

  it('never reports fewer open seats than the caller counted', async () => {
    const result = await make(0, 0).port.evaluate({
      roleCode: 'qa',
      openSeats: 2,
      joiningUserId: 'u1',
      via: 'offer',
    });
    expect(result).toEqual({ deficit: true, openSeats: 2, queued: 0 });
  });
});
