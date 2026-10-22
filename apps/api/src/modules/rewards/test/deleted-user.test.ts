import { afterAll, beforeAll, expect, it } from 'vitest';
import {
  buildProject,
  endCooling,
  finishProject,
  markDesired,
  plantAccounts,
  plantDeficit,
  runPendingRecheck,
  waitCreditRun,
  type Project,
} from '../../../../test/fixtures/rewards.js';
import {
  awardRows,
  counterRowCount,
  counterValue,
  creditsOf,
  projectCreditRows,
  teamAwardRows,
} from '../../../../test/fixtures/rewards-db.js';
import { describeInfra } from '../../../../test/helpers/infra.js';
import { startRewardsWorld, type RewardsWorld } from './support.js';

/*
 * S7 review H-1 / S7SEC-02 (152-FZ): a person who asked for the deletion of the account during the cooling (the
 * account is `deleting`) or whose account is gone (`deleted`) must not get a single row of the credit, a counter or
 * an award at the end of the cooling, although he is still named in the immutable snapshot of the completion. The
 * team bonus goes on to the others, and the daily recheck of pending accounts does not bring his rows back.
 */

describeInfra('S7 review H-1: the credit skips deleted and deleting people', ['db', 'redis', 's3'], () => {
  let rw: RewardsWorld;
  let project: Project;
  const team = (): string => project.fx.team.id;

  beforeAll(async () => {
    rw = await startRewardsWorld();
    project = await buildProject(rw.world, {
      beforeStage: { 2: (p) => markDesired(p, 'backend') },
      beforeCompletion: async (p) => {
        await plantDeficit(p.world, p.fx.team.id, p.backend, true);
        await plantDeficit(p.world, p.fx.team.id, p.frontend, false);
      },
    });
    await finishProject(project);
    // The frontend developer asked for the deletion on the third day, the lead's account is already gone.
    await rw.world.sql`UPDATE auth."user" SET status = 'deleting' WHERE id = ${project.frontend.id}`;
    await rw.world.sql`UPDATE auth."user" SET status = 'deleted' WHERE id = ${project.lead.id}`;
    await plantAccounts(rw.world, [project.backend, project.frontend, project.lead]);
    await endCooling(project, { plant: false });
    await waitCreditRun(rw.world, team(), 'credited');
  }, 300_000);

  afterAll(async () => {
    if (rw) await rw.close();
  });

  const gone = (): string[] => [project.frontend.id, project.lead.id];

  it('no project credit, credit, counter or award row appears for a deleting or deleted person', async () => {
    const credited = await projectCreditRows(rw.world, team());
    expect(credited.map((r) => r.user_id)).toEqual([project.backend.id]);
    for (const userId of gone()) {
      expect(await creditsOf(rw.world, team(), userId), userId).toEqual([]);
      expect(await counterRowCount(rw.world, userId), userId).toBe(0);
      expect(await awardRows(rw.world, userId), userId).toEqual([]);
    }
  });

  it('the person who stays is credited as usual and gets the team bonus alone', async () => {
    expect(await counterValue(rw.world, project.backend.id)).toBe(1);
    const bonus = (await teamAwardRows(rw.world, team())).filter((a) => a.scope === 'team');
    expect(bonus.map((a) => a.user_id)).toEqual([project.backend.id]);
  });

  it('the daily recheck of pending accounts does not bring the rows back', async () => {
    await runPendingRecheck(rw.world);
    for (const userId of gone()) {
      expect(await counterRowCount(rw.world, userId), userId).toBe(0);
      expect(await awardRows(rw.world, userId), userId).toEqual([]);
    }
    expect((await projectCreditRows(rw.world, team())).map((r) => r.user_id)).toEqual([
      project.backend.id,
    ]);
  });
});
