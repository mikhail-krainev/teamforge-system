import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { codesAt, expectReplayOf, fireAll, tally, winnerOf } from '../fixtures/concurrency.js';
import { expectNoDeadlocks } from '../fixtures/teams-db.js';
import {
  completeStageOne,
  itemOf,
  patchItem,
  routeTeam,
  startRouteWorld,
  transition,
  waitMinimumStageTime,
} from '../fixtures/workspace.js';
import { itemRows, openStageCount, stageRows } from '../fixtures/workspace-db.js';
import type { World } from '../fixtures/world.js';
import { FakeClock } from '../helpers/clock.js';
import { describeInfra } from '../helpers/infra.js';

/*
 * CC-5 (docs/architecture.md 11.3, 12.5): T5 = lock #4 `team` -> #8 `project_stage ... FOR UPDATE`;
 * `project_stage_one_open_uq`, `UNIQUE (project_stage_id, step_key)`. Run with `--repeat 5` (plan, S5 criteria).
 */
describeInfra('CC-5: stage transition (FR-WORK-10)', ['db', 'redis'], () => {
  let world: World;
  const clock = new FakeClock(Date.now());
  let deadlocksBefore = 0;

  beforeAll(async () => {
    world = await startRouteWorld({ clock });
    deadlocksBefore = await world.deadlocks();
  });

  afterAll(async () => {
    if (!world) return;
    await expectNoDeadlocks(world, deadlocksBefore);
    await world.close();
  });

  it('CC-5: 20 "Перейти" with different keys -> 1 x 201, 19 x 409 STAGE_NOT_OPEN; one open stage; the items of stage 2 are created once', async () => {
    const t = await routeTeam(world);
    await completeStageOne(t);
    waitMinimumStageTime(world);
    const fired = await fireAll(20, (_i, key) => transition(world, t.lead, t.team.id, 1, { key }));
    expect(tally(fired)).toEqual({ 201: 1, 409: 19 });
    expect(codesAt(fired, 409)).toEqual(['STAGE_NOT_OPEN']);
    expect(winnerOf(fired, 201).response.json()).toEqual({ closedOrdinal: 1, openedOrdinal: 2 });
    expect((await stageRows(world, t.team.id)).map((s) => s.status)).toEqual([
      'closed',
      'open',
      'pending',
    ]);
    expect(await openStageCount(world, t.team.id)).toBe(1);
    expect(await itemRows(world, t.team.id, 2)).toHaveLength(3);
    expect(await itemRows(world, t.team.id)).toHaveLength(5 + 3);
  });

  it('CC-5 (paired): the winner repeated with its own key returns the stored 201; a loser repeated with its key returns the stored 409', async () => {
    const t = await routeTeam(world);
    await completeStageOne(t);
    waitMinimumStageTime(world);
    const fired = await fireAll(6, (_i, key) => transition(world, t.lead, t.team.id, 1, { key }));
    const winner = winnerOf(fired, 201);
    expectReplayOf(winner, await transition(world, t.lead, t.team.id, 1, { key: winner.key }));
    const loser = winnerOf(fired, 409);
    expectReplayOf(loser, await transition(world, t.lead, t.team.id, 1, { key: loser.key }));
    expect(await itemRows(world, t.team.id, 2)).toHaveLength(3);
  });

  it('CC-5: 20 requests with the SAME key -> one transition (201 or the stored replay), never a second stage opened', async () => {
    const t = await routeTeam(world);
    await completeStageOne(t);
    waitMinimumStageTime(world);
    const key = randomUUID();
    const fired = await fireAll(
      20,
      (_i, k) => transition(world, t.lead, t.team.id, 1, { key: k }),
      Array.from({ length: 20 }, () => key),
    );
    for (const f of fired) expect([201, 409]).toContain(f.status);
    expect(fired.some((f) => f.status === 201)).toBe(true);
    expect(await openStageCount(world, t.team.id)).toBe(1);
    expect(await itemRows(world, t.team.id, 2)).toHaveLength(3);
  });

  it('CC-5: a burst on stage 2 whose obligatory items are open is blocked as a whole: 10 x 409 STAGE_TRANSITION_BLOCKED, nothing moves', async () => {
    const t = await routeTeam(world);
    await completeStageOne(t);
    waitMinimumStageTime(world);
    const first = await fireAll(20, (_i, key) => transition(world, t.lead, t.team.id, 1, { key }));
    expect(tally(first)).toEqual({ 201: 1, 409: 19 });
    waitMinimumStageTime(world);
    const blocked = await fireAll(10, (_i, key) =>
      transition(world, t.lead, t.team.id, 2, { key }),
    );
    expect(tally(blocked)).toEqual({ 409: 10 });
    expect(codesAt(blocked, 409)).toEqual(['STAGE_TRANSITION_BLOCKED']);
    expect(await openStageCount(world, t.team.id)).toBe(1);
    expect((await stageRows(world, t.team.id)).map((s) => s.status)).toEqual([
      'closed',
      'open',
      'pending',
    ]);
  });

  describe('against a write to an item of the stage (lock #8: FOR UPDATE of the transition vs FOR SHARE of the write)', () => {
    it('CC-5: reopening an obligatory item while the lead moves the stage -> one consistent outcome, never a closed stage with an open obligatory item', async () => {
      for (let round = 0; round < 5; round += 1) {
        const t = await routeTeam(world);
        await completeStageOne(t);
        waitMinimumStageTime(world);
        const board = await itemOf(t, 'mini_board');
        const fired = await fireAll(2, (i, key) =>
          i === 0
            ? transition(world, t.lead, t.team.id, 1, { key })
            : patchItem(
                world,
                t.backend,
                t.team.id,
                board.id,
                { version: board.version, status: 'open' },
                { key },
              ),
        );
        const [moved, patched] = fired;
        const stages = await stageRows(world, t.team.id);
        const boardNow = (await itemRows(world, t.team.id, 1)).find(
          (i) => i.step_key === 'mini_board',
        );
        if (moved?.status === 201) {
          expect(stages[0]?.status).toBe('closed');
          expect([409]).toContain(patched?.status);
          expect(boardNow?.status).toBe('done');
        } else {
          expect(moved?.status).toBe(409);
          expect(patched?.status).toBe(200);
          expect(boardNow?.status).toBe('open');
          expect(stages[0]?.status).toBe('open');
        }
        expect(await openStageCount(world, t.team.id)).toBe(1);
      }
    });
  });
});
