import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { codesAt, expectReplayOf, fireAll, tally, winnerOf } from '../fixtures/concurrency.js';
import { expectOk } from '../fixtures/teams.js';
import { expectNoDeadlocks, teamRow } from '../fixtures/teams-db.js';
import { routeTeam, startRouteWorld } from '../fixtures/workspace.js';
import { itemRows, openStageCount, stageRows } from '../fixtures/workspace-db.js';
import type { World } from '../fixtures/world.js';
import { describeInfra } from '../helpers/infra.js';

/*
 * CC-13, the "Начать" part (FR-TEAM-10, S5-04): T4 = lock #4 `team`, status `forming`;
 * `project_stage UNIQUE (team_id, ordinal)`, `UNIQUE (project_stage_id, step_key)`.
 * "Перейти" against "Завершить" on the last stage appears with completeProject (slice 6): the test is completed there.
 */
describeInfra('CC-13: 20 "Начать" -> one first stage (FR-TEAM-10)', ['db', 'redis'], () => {
  let world: World;
  let deadlocksBefore = 0;

  beforeAll(async () => {
    world = await startRouteWorld();
    deadlocksBefore = await world.deadlocks();
  });

  afterAll(async () => {
    if (!world) return;
    await expectNoDeadlocks(world, deadlocksBefore);
    await world.close();
  });

  const start = (leadId: string, teamId: string, key: string) =>
    world.as(leadId).post(`/v1/teams/${teamId}/start`, undefined, { idempotencyKey: key });

  it('CC-13: 20 parallel starts with different keys -> 1 x 200, 19 x 409; 3 stages with stage 1 open once; its 5 items exist once', async () => {
    const t = await routeTeam(world, { started: false });
    const fired = await fireAll(20, (_i, key) => start(t.lead.id, t.team.id, key));
    expect(tally(fired)).toEqual({ 200: 1, 409: 19 });
    for (const code of codesAt(fired, 409))
      expect(['INVALID_STATE', 'TEAM_STATUS_BLOCKS_ACTION']).toContain(code);
    expect((await teamRow(world, t.team.id)).status).toBe('active');
    expect((await stageRows(world, t.team.id)).map((s) => [s.ordinal, s.status])).toEqual([
      [1, 'open'],
      [2, 'pending'],
      [3, 'pending'],
    ]);
    expect(await openStageCount(world, t.team.id)).toBe(1);
    expect(await itemRows(world, t.team.id)).toHaveLength(5);
  });

  it('CC-13 (paired): the winning start repeated with its key returns the stored 200', async () => {
    const t = await routeTeam(world, { started: false });
    const fired = await fireAll(5, (_i, key) => start(t.lead.id, t.team.id, key));
    const winner = winnerOf(fired, 200);
    expectReplayOf(winner, await start(t.lead.id, t.team.id, winner.key));
    expect(await itemRows(world, t.team.id)).toHaveLength(5);
  });

  it('FR-WORK-01: the start and the route are one transaction: a started team always has its open stage', async () => {
    const t = await routeTeam(world, { started: false });
    expectOk('startProject', await start(t.lead.id, t.team.id, randomUUID()), 200);
    expect((await teamRow(world, t.team.id)).status).toBe('active');
    expect(await openStageCount(world, t.team.id)).toBe(1);
  });
});
