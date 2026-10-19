import { afterAll, beforeAll, expect, it } from 'vitest';
import { requestCheck } from '../fixtures/completion.js';
import { codesAt, fireAll, tally } from '../fixtures/concurrency.js';
import { completionCheckCount } from '../fixtures/github-db.js';
import { expectNoDeadlocks } from '../fixtures/teams-db.js';
import { routeTeam, startRouteWorld } from '../fixtures/workspace.js';
import type { World } from '../fixtures/world.js';
import { FakeClock } from '../helpers/clock.js';
import { describeInfra } from '../helpers/infra.js';

/*
 * S6SEC-02 (FR-WORK-13, architecture 11.4, 12.3): requestCompletionCheck takes lock #4 for update, so
 * N requests at once find the team idle exactly once: one check is queued, the others are 409
 * INVALID_STATE. No worker runs, so the one check stays queued while the burst arrives.
 */

const N = 12;

describeInfra('S6SEC-02: N requests for a completion check -> one check', ['db', 'redis'], () => {
  let world: World;
  const clock = new FakeClock(Date.now());
  let deadlocksBefore = 0;

  beforeAll(async () => {
    world = await startRouteWorld({ github: true, clock, worker: false });
    deadlocksBefore = await world.deadlocks();
  });

  afterAll(async () => {
    if (!world) return;
    await expectNoDeadlocks(world, deadlocksBefore);
    await world.close();
  });

  it(`${N} requests at once -> one 202, the rest 409 INVALID_STATE, one row`, async () => {
    const fx = await routeTeam(world);
    const fired = await fireAll(N, () => requestCheck(world, fx.lead, fx.team.id));
    expect(tally(fired)).toEqual({ 202: 1, 409: N - 1 });
    expect(new Set(codesAt(fired, 409))).toEqual(new Set(['INVALID_STATE']));
    expect(await completionCheckCount(world, fx.team.id)).toBe(1);
  });
});
