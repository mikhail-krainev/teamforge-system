import { Test } from '@nestjs/testing';
import { describe, expect, it } from 'vitest';
import {
  DEFICIT_PORT,
  TEAM_LIFECYCLE_PORT,
  type DeficitPort,
  type TeamLifecyclePort,
} from '../../public.js';
import { StubDeficitPort, StubTeamLifecyclePort } from './stub-ports.js';

/** The contract every implementation of the ports must keep; the stubs are the first one. */
function deficitPortContract(make: () => DeficitPort): void {
  it('echoes the open seat count and reports a non-negative queue', async () => {
    const result = await make().evaluate({
      roleCode: 'backend',
      openSeats: 2,
      joiningUserId: 'u1',
      via: 'offer',
    });
    expect(result.openSeats).toBe(2);
    expect(result.queued).toBeGreaterThanOrEqual(0);
    expect(typeof result.deficit).toBe('boolean');
  });
}

describe('DeficitPort (stub)', () => {
  deficitPortContract(() => new StubDeficitPort());

  it('reports no deficit and an empty queue', async () => {
    await expect(
      new StubDeficitPort().evaluate({
        roleCode: 'qa',
        openSeats: 1,
        joiningUserId: 'u1',
        via: 'auto',
      }),
    ).resolves.toEqual({ deficit: false, openSeats: 1, queued: 0 });
  });
});

describe('TeamLifecyclePort (stub)', () => {
  it('accepts a project start without effect', async () => {
    const port: TeamLifecyclePort = new StubTeamLifecyclePort();
    await expect(
      port.onProjectStarted({ teamId: 't', playbookId: 'p', startedAt: new Date() }),
    ).resolves.toBeUndefined();
  });
});

describe('port bindings', () => {
  it('resolve through the tokens exported by teams/public', async () => {
    const moduleRef = await Test.createTestingModule({
      providers: [
        { provide: DEFICIT_PORT, useClass: StubDeficitPort },
        { provide: TEAM_LIFECYCLE_PORT, useClass: StubTeamLifecyclePort },
      ],
    }).compile();
    expect(moduleRef.get<DeficitPort>(DEFICIT_PORT)).toBeInstanceOf(StubDeficitPort);
    expect(moduleRef.get<TeamLifecyclePort>(TEAM_LIFECYCLE_PORT)).toBeInstanceOf(
      StubTeamLifecyclePort,
    );
  });
});
