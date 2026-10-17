import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { DAY } from '../../../../test/fixtures/teams.js';
import {
  advanceStage,
  clockOf,
  completeStageOne,
  routeTeam,
  stagesOf,
  type RouteFixture,
} from '../../../../test/fixtures/workspace.js';
import { stageRows } from '../../../../test/fixtures/workspace-db.js';
import type { World } from '../../../../test/fixtures/world.js';
import { FakeClock } from '../../../../test/helpers/clock.js';
import { describeInfra, waitFor } from '../../../../test/helpers/infra.js';
import { startWorld } from './support.js';

/*
 * S5-08, the tail: the due date of the open stage moves by the time the team spent suspended
 * (FR-WORK-18, architecture 11.4) and stays moved once the team works again; the stage events of
 * architecture 4 (`workspace.stage_opened`, `workspace.stage_closed`) are published when the first
 * stage opens at the start and at every transition.
 */

describeInfra(
  'S5 workspace: suspension moves the stage deadline, stage events (FR-WORK-18, architecture 11.3, 11.4)',
  ['db', 'redis'],
  () => {
    let world: World;
    const clock = new FakeClock(Date.now());

    beforeAll(async () => {
      world = await startWorld({ clock });
    });

    afterAll(async () => {
      if (!world) return;
      await world.close();
    });

    /** What the status journal of the team does: the status moves and the event goes out. */
    const suspend = (teamId: string) =>
      world.sql`
        UPDATE teams.team SET status = 'suspended', suspended_at = ${clock.now()} WHERE id = ${teamId}`;

    const resume = async (teamId: string, spentSeconds: number) => {
      await world.sql`
        UPDATE teams.team
           SET status = 'active', suspended_at = NULL,
               suspended_total_seconds = suspended_total_seconds + ${spentSeconds}
         WHERE id = ${teamId}`;
      await world.sql`
        INSERT INTO platform.outbox_event (id, module, type, aggregate_id, payload, created_at)
        VALUES (${randomUUID()}, 'teams', 'team_status_changed', ${teamId},
                ${world.sql.json({ teamId, from: 'suspended', to: 'active', reason: 'test' })}, now())`;
    };

    const firstStage = async (fx: RouteFixture) => {
      const [stage] = await stageRows(world, fx.team.id);
      if (!stage?.due_at) throw new Error('stage 1 has no due date');
      return stage as typeof stage & { due_at: Date };
    };

    const dueOf = async (fx: RouteFixture): Promise<number> => {
      const first = (await stagesOf(world, fx.lead, fx.team.id)).items[0];
      return Date.parse(first?.dueAt ?? '');
    };

    it('FR-WORK-18: after the team works again the open stage keeps the suspension: stored due_at moves once, the shown date does not jump back', async () => {
      const fx = await routeTeam(world);
      const original = (await firstStage(fx)).due_at.getTime();

      clock.advance(DAY);
      await suspend(fx.team.id);
      clock.advance(3 * DAY);
      expect(await dueOf(fx)).toBe(original + 3 * DAY);

      await resume(fx.team.id, 3 * 86_400);
      // Before the event is processed the date is already right (the pending suspension is added on read) ...
      expect(await dueOf(fx)).toBe(original + 3 * DAY);
      // ... and after it the stored date itself carries it.
      await waitFor(async () => (await firstStage(fx)).due_at.getTime() === original + 3 * DAY);
      expect(await dueOf(fx)).toBe(original + 3 * DAY);
      expect((await firstStage(fx)).due_at.getTime()).toBe(original + 3 * DAY);
    });

    it('FR-WORK-18: a status change that ends no suspension moves nothing, and a repeated event does not move it twice', async () => {
      const fx = await routeTeam(world);
      const original = (await firstStage(fx)).due_at.getTime();
      await world.sql`
        INSERT INTO platform.outbox_event (id, module, type, aggregate_id, payload, created_at)
        VALUES (${randomUUID()}, 'teams', 'team_status_changed', ${fx.team.id},
                ${world.sql.json({ teamId: fx.team.id, from: 'active', to: 'voting', reason: 'test' })}, now())`;
      await suspend(fx.team.id);
      await resume(fx.team.id, 2 * 86_400);
      await waitFor(async () => (await firstStage(fx)).due_at.getTime() === original + 2 * DAY);
      await resume(fx.team.id, 0);
      await resume(fx.team.id, 0);
      // Let the relay deliver the repeats, then check that nothing moved again.
      await new Promise((resolve) => setTimeout(resolve, 1_500));
      expect((await firstStage(fx)).due_at.getTime()).toBe(original + 2 * DAY);
    });

    it('FR-WORK-18: a stage that opens after a suspension is not moved by it (the suspension was before its time)', async () => {
      const fx = await routeTeam(world);
      await suspend(fx.team.id);
      clock.advance(2 * DAY);
      await resume(fx.team.id, 2 * 86_400);
      await completeStageOne(fx);
      await advanceStage(fx, 1);
      const [, second] = await stageRows(world, fx.team.id);
      if (!second?.opened_at || !second.due_at) throw new Error('stage 2 did not open');
      expect(second.due_at.getTime() - second.opened_at.getTime()).toBe(second.duration_days * DAY);
      await new Promise((resolve) => setTimeout(resolve, 1_000));
      const [, after] = await stageRows(world, fx.team.id);
      expect(after?.due_at?.getTime()).toBe(second.due_at.getTime());
      const row = await world.sql<{ applied: number }[]>`
        SELECT suspended_applied_seconds AS applied FROM workspace.project_stage
         WHERE team_id = ${fx.team.id} AND ordinal = 2`;
      expect(row[0]?.applied).toBe(2 * 86_400);
      expect(clockOf(world)).toBe(clock);
    });

    it('FR-WORK-18: two separate suspensions add up: the due date moves by 2 days, then by 3 more (5 in all), never by the total twice', async () => {
      const fx = await routeTeam(world);
      const original = (await firstStage(fx)).due_at.getTime();

      await suspend(fx.team.id);
      clock.advance(2 * DAY);
      await resume(fx.team.id, 2 * 86_400);
      await waitFor(async () => (await firstStage(fx)).due_at.getTime() === original + 2 * DAY);

      clock.advance(DAY);
      await suspend(fx.team.id);
      clock.advance(3 * DAY);
      // While it lasts the shown date already includes the second suspension and the first one once.
      expect(await dueOf(fx)).toBe(original + 5 * DAY);
      await resume(fx.team.id, 3 * 86_400);
      await waitFor(async () => (await firstStage(fx)).due_at.getTime() === original + 5 * DAY);
      expect(await dueOf(fx)).toBe(original + 5 * DAY);
      const row = await world.sql<{ applied: number }[]>`
        SELECT suspended_applied_seconds AS applied FROM workspace.project_stage
         WHERE team_id = ${fx.team.id} AND ordinal = 1`;
      expect(row[0]?.applied).toBe(5 * 86_400);
    });

    it('FR-WORK-18: a stage that opens between two suspensions keeps only the later one: the earlier is its baseline, not a shift', async () => {
      const fx = await routeTeam(world);
      await suspend(fx.team.id);
      clock.advance(2 * DAY);
      await resume(fx.team.id, 2 * 86_400);
      await completeStageOne(fx);
      await advanceStage(fx, 1);
      const [, second] = await stageRows(world, fx.team.id);
      if (!second?.due_at) throw new Error('stage 2 did not open');
      const planned = second.due_at.getTime();

      await suspend(fx.team.id);
      clock.advance(DAY);
      await resume(fx.team.id, 86_400);
      await waitFor(
        async () => (await stageRows(world, fx.team.id))[1]?.due_at?.getTime() === planned + DAY,
      );
      const rows = await world.sql<{ ordinal: number; applied: number }[]>`
        SELECT ordinal, suspended_applied_seconds AS applied FROM workspace.project_stage
         WHERE team_id = ${fx.team.id} ORDER BY ordinal`;
      expect(rows.map((r) => r.applied)).toEqual([2 * 86_400, 3 * 86_400, 0]);
    });

    const eventsOf = (teamId: string) =>
      world.sql<{ type: string; payload: { teamId: string; ordinal: number } }[]>`
        SELECT type, payload FROM platform.outbox_event
         WHERE module = 'workspace' AND type IN ('stage_opened', 'stage_closed')
           AND payload->>'teamId' = ${teamId}
         ORDER BY id`;

    it('architecture 4: the start publishes workspace.stage_opened for stage 1; a transition publishes stage_closed and stage_opened with teamId and ordinal', async () => {
      const fx = await routeTeam(world);
      expect((await eventsOf(fx.team.id)).map((e) => [e.type, e.payload.ordinal])).toEqual([
        ['stage_opened', 1],
      ]);
      await completeStageOne(fx);
      await advanceStage(fx, 1);
      const events = await eventsOf(fx.team.id);
      expect(events.map((e) => [e.type, e.payload.ordinal])).toEqual([
        ['stage_opened', 1],
        ['stage_closed', 1],
        ['stage_opened', 2],
      ]);
      expect(events.every((e) => e.payload.teamId === fx.team.id)).toBe(true);
    });
  },
);
