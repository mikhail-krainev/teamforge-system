import { afterAll, beforeAll, expect, it } from 'vitest';
import { DAY, expectOk } from '../../../../test/fixtures/teams.js';
import { clockOf, routeTeam } from '../../../../test/fixtures/workspace.js';
import type { World } from '../../../../test/fixtures/world.js';
import { FakeClock } from '../../../../test/helpers/clock.js';
import { describeInfra } from '../../../../test/helpers/infra.js';
import { StageDueNotify, STAGE_OVERDUE_NOTIFY_DAYS } from '../internal/jobs/stage-due-notify.js';
import { TransitionRepository } from '../internal/repositories/transition.repository.js';
import { TxRunner } from '../../../platform/tx/tx-runner.js';
import { startWorld } from './support.js';

/** `stage-due-notify` (FR-WORK-19, FR-WORK-12): the team hears a day before the due date and when it is past, once each. */
describeInfra('S5 workspace: stage-due-notify timer', ['db', 'redis'], () => {
  let world: World;
  const clock = new FakeClock(Date.now());

  beforeAll(async () => {
    world = await startWorld({ clock });
  });

  afterAll(async () => {
    if (!world) return;
    await world.close();
  });

  const dueNotices = async (who: Parameters<World['as']>[0]) =>
    expectOk<{ items: { type: string; payload: Record<string, unknown> }[] }>(
      'listNotifications',
      await world.as(who).get('/v1/me/notifications'),
      200,
    ).items.filter((n) => n.type === 'stage_due');

  it('FR-WORK-19, C-54: nothing early; "soon" within two days of the due date, "due_day" on the day, "overdue" after it; a repeated scan creates nothing', async () => {
    const t = await routeTeam(world);
    const timer = world.app.get(StageDueNotify);
    const phasesOf = async (who: Parameters<World['as']>[0]) =>
      (await dueNotices(who)).map((n) => n.payload['phase']).sort();
    // The stage lasts 7 days from its opening.
    clockOf(world).advance(4 * DAY);
    await timer.scan();
    expect(await phasesOf(t.backend)).toEqual([]);

    clockOf(world).advance(1.5 * DAY);
    await timer.scan();
    await timer.scan();
    for (const member of [t.lead, t.backend, t.frontend]) {
      expect(await phasesOf(member)).toEqual(['soon']);
    }

    clockOf(world).advance(1.49 * DAY);
    await timer.scan();
    expect(await phasesOf(t.lead)).toEqual(['due_day', 'soon']);

    clockOf(world).advance(1 * DAY);
    await timer.scan();
    expect(await phasesOf(t.lead)).toEqual(['due_day', 'overdue', 'soon']);
  });

  it('stages handled already do not starve the later ones: a scan walks every page', async () => {
    const teams = [await routeTeam(world), await routeTeam(world), await routeTeam(world)];
    clockOf(world).advance(6 * DAY);
    const timer = world.app.get(StageDueNotify);
    await timer.scan(1);
    for (const t of teams) {
      expect((await dueNotices(t.lead)).map((n) => n.payload['phase'])).toContain('soon');
    }
    expect(await timer.scan(1)).toBe(0);
  });

  const setDueAt = async (teamId: string, dueAt: string): Promise<void> => {
    await world.sql`
      UPDATE workspace.project_stage SET due_at = ${dueAt}::text::timestamptz
       WHERE team_id = ${teamId} AND status = 'open'`;
  };

  it('the page cursor keeps the microseconds of due_at: stages due in the same millisecond are each returned once', async () => {
    const teams = [await routeTeam(world), await routeTeam(world), await routeTeam(world)];
    const base = new Date(clock.now().getTime() + DAY);
    base.setUTCMilliseconds(0);
    const stamp = base.toISOString().replace('.000Z', '');
    for (const [i, t] of teams.entries()) await setDueAt(t.team.id, `${stamp}.000${i + 1}23+00`);
    const tx = world.app.get(TxRunner);
    const repository = world.app.get(TransitionRepository);
    const since = new Date(base.getTime() - 1_000);
    const until = new Date(base.getTime() + 1_000);
    const seen: string[] = [];
    let after: Awaited<ReturnType<TransitionRepository['dueBetween']>>['next'];
    for (let page = 0; page < 6; page += 1) {
      const cursor = after;
      const result = await tx.run(() => repository.dueBetween(since, until, 1, cursor));
      seen.push(...result.stages.map((stage) => stage.teamId));
      if (result.next === undefined) break;
      after = result.next;
    }
    // Stages of earlier tests due at the same instant may be in the window too; each of ours comes once, in order.
    const ours = new Set(teams.map((t) => t.team.id));
    expect(seen.filter((id) => ours.has(id))).toEqual(teams.map((t) => t.team.id));
    expect(new Set(seen).size).toBe(seen.length);
  });

  it(`a stage more than ${STAGE_OVERDUE_NOTIFY_DAYS} days past its due date is no longer announced; one a little earlier still is`, async () => {
    const old = await routeTeam(world);
    const recent = await routeTeam(world);
    const now = clock.now().getTime();
    const ago = (days: number) => new Date(now - days * DAY).toISOString();
    await setDueAt(old.team.id, ago(STAGE_OVERDUE_NOTIFY_DAYS + 1));
    await setDueAt(recent.team.id, ago(STAGE_OVERDUE_NOTIFY_DAYS - 1));
    await world.app.get(StageDueNotify).scan();
    expect(await dueNotices(old.lead)).toEqual([]);
    expect((await dueNotices(recent.lead)).map((n) => n.payload['phase'])).toEqual(['overdue']);
  });
});
