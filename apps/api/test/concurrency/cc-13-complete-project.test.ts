import { afterAll, beforeAll, expect, it } from 'vitest';
import { startFakeLinkChecker, type FakeLinkChecker } from '../fakes/link-checker.js';
import {
  complete,
  completableTeam,
  runCheck,
  unmetCodes,
  type CompletableTeam,
} from '../fixtures/completion.js';
import { codesAt, expectReplayOf, fireAll, tally, winnerOf } from '../fixtures/concurrency.js';
import {
  completionCount,
  contributionRows,
  outboxCount,
  repoLinkRows,
} from '../fixtures/github-db.js';
import { expectNoDeadlocks, teamRow } from '../fixtures/teams-db.js';
import { startRouteWorld, transition } from '../fixtures/workspace.js';
import { openStageCount, stageRows } from '../fixtures/workspace-db.js';
import type { World } from '../fixtures/world.js';
import { FakeClock } from '../helpers/clock.js';
import { describeInfra, waitFor } from '../helpers/infra.js';

/*
 * CC-13, the "Завершить" part (FR-WORK-13, S6-02; architecture 11.4, 12.2): T6 = lock #4 `team` with status
 * `active`; `project_completion` has the primary key `team_id`. The transition of a stage takes #4 too, so
 * "Перейти" and "Завершить" are serialised. The "Начать" part of CC-13 is in cc-13-start-route.test.ts.
 */

const N = 20;

describeInfra('CC-13: 20 "Завершить" -> one completion (FR-WORK-13)', ['db', 'redis', 's3'], () => {
  let world: World;
  let checker: FakeLinkChecker;
  const clock = new FakeClock(Date.now());
  let deadlocksBefore = 0;

  beforeAll(async () => {
    world = await startRouteWorld({ github: true, clock });
    checker = startFakeLinkChecker(world.queuePrefix);
    deadlocksBefore = await world.deadlocks();
  });

  afterAll(async () => {
    await checker?.close();
    if (!world) return;
    await expectNoDeadlocks(world, deadlocksBefore);
    await world.close();
  });

  const ready = async (): Promise<CompletableTeam> => {
    const c = await completableTeam(world);
    await runCheck(world, c.fx.lead, c.fx.team.id);
    return c;
  };

  it('CC-13: 20 parallel "Завершить" with different keys -> 1 x 201, 19 x 409; one project_completion row', async () => {
    const c = await ready();
    const fired = await fireAll(N, (_i, key) => complete(world, c.fx.lead, c.fx.team.id, key));
    expect(tally(fired)).toEqual({ 201: 1, 409: N - 1 });
    for (const code of codesAt(fired, 409)) {
      expect(['INVALID_STATE', 'TEAM_STATUS_BLOCKS_ACTION']).toContain(code);
    }
    expect(await completionCount(world, c.fx.team.id)).toBe(1);
    expect((await teamRow(world, c.fx.team.id)).status).toBe('completed');
    expect((await repoLinkRows(world, c.fx.team.id)).map((r) => r.status)).toEqual(['completed']);
    const rows = await contributionRows(world, c.fx.team.id);
    expect(rows.every((r) => r.role_locked)).toBe(true);
    await waitFor(async () => (await outboxCount(world, 'project_completed', c.fx.team.id)) >= 1);
    expect(await outboxCount(world, 'project_completed', c.fx.team.id)).toBe(1);
  }, 240_000);

  it('CC-13 (paired): the winner repeats his key -> the stored 201; a loser repeats his key -> the stored 409; still one row', async () => {
    const c = await ready();
    const fired = await fireAll(5, (_i, key) => complete(world, c.fx.lead, c.fx.team.id, key));
    const winner = winnerOf(fired, 201);
    const loser = winnerOf(fired, 409);
    expectReplayOf(winner, await complete(world, c.fx.lead, c.fx.team.id, winner.key));
    expectReplayOf(loser, await complete(world, c.fx.lead, c.fx.team.id, loser.key));
    expect(await completionCount(world, c.fx.team.id)).toBe(1);
  }, 240_000);

  it('CC-13: 20 "Завершить" with one key -> the same answer for all; one completion', async () => {
    const c = await ready();
    const key = 'same-key-for-every-press';
    const fired = await fireAll(
      N,
      (_i, k) => complete(world, c.fx.lead, c.fx.team.id, k),
      Array.from({ length: N }, () => key),
    );
    const statuses = new Set(fired.map((f) => f.status));
    expect([...statuses].every((s) => [201, 409].includes(s))).toBe(true);
    expect(fired.filter((f) => f.status === 201).length).toBeGreaterThanOrEqual(1);
    expect(await completionCount(world, c.fx.team.id)).toBe(1);
  }, 240_000);

  it.each([1, 2, 3])(
    'CC-13: "Завершить" against "Перейти" on the last stage (round %i) -> one outcome, no completed project with an open stage',
    async () => {
      const c = await completableTeam(world, { keepLastStageOpen: true });
      await runCheck(world, c.fx.lead, c.fx.team.id);
      const results = await Promise.all([
        complete(world, c.fx.lead, c.fx.team.id),
        transition(world, c.fx.lead, c.fx.team.id, 3),
      ]);
      const [completed, moved] = results;
      expect(moved?.statusCode, moved?.body).toBe(201);
      if (completed?.statusCode === 201) {
        expect(await completionCount(world, c.fx.team.id)).toBe(1);
      } else {
        expect(completed?.statusCode, completed?.body).toBe(409);
        expect(completed?.json<{ code: string }>().code).toBe('COMPLETION_BLOCKED');
        expect(unmetCodes(completed as NonNullable<typeof completed>)).toEqual([
          'STAGES_NOT_CLOSED',
        ]);
        expect(await completionCount(world, c.fx.team.id)).toBe(0);
        const again = await complete(world, c.fx.lead, c.fx.team.id);
        expect(again.statusCode, again.body).toBe(201);
      }
      expect(await completionCount(world, c.fx.team.id)).toBe(1);
      expect(await openStageCount(world, c.fx.team.id)).toBe(0);
      expect((await stageRows(world, c.fx.team.id)).every((s) => s.status === 'closed')).toBe(true);
      expect((await teamRow(world, c.fx.team.id)).status).toBe('completed');
    },
    240_000,
  );

  it('CC-13: 20 "Перейти" on the last stage together with 20 "Завершить" -> the stage closes once, the project completes once', async () => {
    const c = await completableTeam(world, { keepLastStageOpen: true });
    await runCheck(world, c.fx.lead, c.fx.team.id);
    const fired = await fireAll(2 * N, (i, key) =>
      i % 2 === 0
        ? complete(world, c.fx.lead, c.fx.team.id, key)
        : transition(world, c.fx.lead, c.fx.team.id, 3, { key }),
    );
    const completes = fired.filter((f) => f.index % 2 === 0);
    const moves = fired.filter((f) => f.index % 2 === 1);
    expect(moves.filter((f) => f.status === 201)).toHaveLength(1);
    for (const f of moves.filter((m) => m.status !== 201)) {
      expect(f.status).toBe(409);
      expect(['STAGE_NOT_OPEN', 'TEAM_STATUS_BLOCKS_ACTION', 'INVALID_STATE']).toContain(f.code);
    }
    expect(completes.filter((f) => f.status === 201).length).toBeLessThanOrEqual(1);
    for (const f of completes.filter((x) => x.status !== 201)) {
      expect(f.status).toBe(409);
      expect(['COMPLETION_BLOCKED', 'INVALID_STATE', 'TEAM_STATUS_BLOCKS_ACTION']).toContain(
        f.code,
      );
    }
    expect(await completionCount(world, c.fx.team.id)).toBeLessThanOrEqual(1);
    expect(await openStageCount(world, c.fx.team.id)).toBe(0);
    if ((await completionCount(world, c.fx.team.id)) === 0) {
      expect((await complete(world, c.fx.lead, c.fx.team.id)).statusCode).toBe(201);
    }
    expect(await completionCount(world, c.fx.team.id)).toBe(1);
  }, 240_000);
});
