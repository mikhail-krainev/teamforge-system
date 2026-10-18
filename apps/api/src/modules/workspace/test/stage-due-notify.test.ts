import { afterAll, beforeAll, expect, it } from 'vitest';
import { DAY, expectOk } from '../../../../test/fixtures/teams.js';
import { clockOf, routeTeam } from '../../../../test/fixtures/workspace.js';
import type { World } from '../../../../test/fixtures/world.js';
import { FakeClock } from '../../../../test/helpers/clock.js';
import { describeInfra } from '../../../../test/helpers/infra.js';
import { StageDueNotify } from '../internal/jobs/stage-due-notify.js';
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
});
