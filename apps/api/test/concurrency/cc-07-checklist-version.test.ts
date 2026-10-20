import { afterAll, beforeAll, expect, it } from 'vitest';
import { expectReplayOf, fireAll, tally, winnerOf } from '../fixtures/concurrency.js';
import { expectNoDeadlocks } from '../fixtures/teams-db.js';
import {
  itemOf,
  patchItem,
  routeTeam,
  startRouteWorld,
  type ChecklistItemDto,
} from '../fixtures/workspace.js';
import { itemRow } from '../fixtures/workspace-db.js';
import type { World } from '../fixtures/world.js';
import { describeInfra } from '../helpers/infra.js';

/*
 * CC-7 (docs/architecture.md 12.2): `UPDATE checklist_item SET ..., version = version + 1 WHERE id = :id AND version = :v`
 * after `project_stage FOR SHARE` (#8); 0 rows -> read the current row -> 409 VERSION_CONFLICT with `current`.
 * The writes use the outcome of a ritual: it has no per-hour limit (links have, SEC-05).
 */
describeInfra('CC-7: checklist item writes with a version (FR-WORK-07)', ['db', 'redis'], () => {
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

  const outcome = (i: number): string => `Итоги встречи номер ${i}: записали договорённости.`;

  for (const n of [2, 20]) {
    it(`CC-7: ${n} parallel writes with version N -> 1 x 200 (version N+1), ${n - 1} x 409 VERSION_CONFLICT with current; no write is lost`, async () => {
      const t = await routeTeam(world);
      const kickoff = await itemOf(t, 'mini_kickoff');
      const people = [t.backend, t.frontend, t.lead];
      const fired = await fireAll(n, (i, key) =>
        patchItem(
          world,
          people[i % people.length] ?? t.lead,
          t.team.id,
          kickoff.id,
          { version: kickoff.version, outcome: outcome(i) },
          { key },
        ),
      );
      expect(tally(fired)).toEqual({ 200: 1, 409: n - 1 });
      const winner = winnerOf(fired, 200);
      expect(winner.response.json<ChecklistItemDto>()).toMatchObject({
        version: kickoff.version + 1,
        outcome: outcome(winner.index),
      });
      for (const f of fired.filter((x) => x.status === 409)) {
        const body = f.response.json<{ code: string; current: ChecklistItemDto }>();
        expect(body.code).toBe('VERSION_CONFLICT');
        expect(body.current.id).toBe(kickoff.id);
      }
      const stored = await itemRow(world, kickoff.id);
      expect(stored.version).toBe(kickoff.version + 1);
      expect((await itemOf(t, 'mini_kickoff')).outcome).toBe(outcome(winner.index));
    });
  }

  it('CC-7: the losers reapply on top of the current version one after another -> all succeed, the version counts every write', async () => {
    const t = await routeTeam(world);
    const kickoff = await itemOf(t, 'mini_kickoff');
    const fired = await fireAll(6, (i, key) =>
      patchItem(
        world,
        t.backend,
        t.team.id,
        kickoff.id,
        { version: kickoff.version, outcome: outcome(i) },
        { key },
      ),
    );
    let current = winnerOf(fired, 200).response.json<ChecklistItemDto>();
    for (const [step, loser] of fired.filter((f) => f.status === 409).entries()) {
      const retry = await patchItem(world, t.backend, t.team.id, kickoff.id, {
        version: current.version,
        outcome: outcome(100 + loser.index),
      });
      expect(retry.statusCode, `retry ${step}`).toBe(200);
      current = retry.json<ChecklistItemDto>();
    }
    expect(current.version).toBe(kickoff.version + 6);
    expect((await itemRow(world, kickoff.id)).version).toBe(kickoff.version + 6);
  });

  it('CC-7 (paired): the winner repeated with its key returns the stored 200 (no new version); a loser repeated -> the stored 409', async () => {
    const t = await routeTeam(world);
    const kickoff = await itemOf(t, 'mini_kickoff');
    const send = (i: number, key: string) =>
      patchItem(
        world,
        t.backend,
        t.team.id,
        kickoff.id,
        { version: kickoff.version, outcome: outcome(i) },
        { key },
      );
    const fired = await fireAll(4, send);
    const winner = winnerOf(fired, 200);
    expectReplayOf(winner, await send(winner.index, winner.key));
    const loser = winnerOf(fired, 409);
    expectReplayOf(loser, await send(loser.index, loser.key));
    expect((await itemRow(world, kickoff.id)).version).toBe(kickoff.version + 1);
  });

  it('CC-7: writes to different items of the same stage do not conflict with each other', async () => {
    const t = await routeTeam(world);
    const kickoff = await itemOf(t, 'mini_kickoff');
    const spec = await itemOf(t, 'mini_spec');
    const [a, b] = await Promise.all([
      patchItem(world, t.backend, t.team.id, kickoff.id, {
        version: kickoff.version,
        outcome: outcome(1),
      }),
      patchItem(world, t.backend, t.team.id, spec.id, {
        version: spec.version,
        roleCode: 'backend',
      }),
    ]);
    expect([a.statusCode, b.statusCode]).toEqual([200, 200]);
  });
});
