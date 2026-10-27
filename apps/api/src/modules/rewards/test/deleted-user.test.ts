import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  buildProject,
  completedProject,
  decide,
  endCooling,
  finishProject,
  markDesired,
  openCaseOf,
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
  creditRunRow,
  creditsOf,
  projectCreditRows,
  teamAwardRows,
} from '../../../../test/fixtures/rewards-db.js';
import { expectOk } from '../../../../test/fixtures/teams.js';
import { describeInfra } from '../../../../test/helpers/infra.js';
import { startRewardsWorld, type RewardsWorld } from './support.js';

/*
 * S7 review H-1 / S7SEC-02 (152-FZ): a person who asked for the deletion of the account during the cooling (the
 * account is `deleting`) or whose account is gone (`deleted`) must not get a single row of the credit, a counter or
 * an award at the end of the cooling, although he is still named in the immutable snapshot of the completion. The
 * team bonus goes on to the others, and the daily recheck of pending accounts does not bring his rows back. The same
 * holds for a person whose credit waits for the GitHub account (the recheck does not promote him once he asked for
 * the deletion) and for the credit that follows the decision "ok" of the administrator.
 */

describeInfra(
  'S7 review H-1: the credit skips deleted and deleting people',
  ['db', 'redis', 's3'],
  () => {
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
      await rw.world
        .sql`UPDATE auth."user" SET status = 'deleting' WHERE id = ${project.frontend.id}`;
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
    describe('a pending account and the decision "ok"', () => {
      it('the daily recheck does not promote a person who asked for the deletion after his credit waited for the account', async () => {
        const pending = await completedProject(rw.world);
        await plantAccounts(rw.world, [pending.lead, pending.backend]);
        await plantAccounts(rw.world, [pending.frontend], { ageDays: 3 });
        await endCooling(pending, { plant: false });
        await waitCreditRun(rw.world, pending.fx.team.id, 'credited');
        expect(
          (await creditsOf(rw.world, pending.fx.team.id, pending.frontend.id)).map((c) => c.status),
        ).toEqual(['pending_account']);
        await rw.world
          .sql`UPDATE auth."user" SET status = 'deleting' WHERE id = ${pending.frontend.id}`;
        await plantAccounts(rw.world, [pending.frontend]);
        await runPendingRecheck(rw.world);
        expect(
          (await creditsOf(rw.world, pending.fx.team.id, pending.frontend.id)).some(
            (c) => c.status === 'credited',
          ),
        ).toBe(false);
        expect(await counterRowCount(rw.world, pending.frontend.id)).toBe(0);
        expect(await awardRows(rw.world, pending.frontend.id)).toEqual([]);
      }, 300_000);

      it('the decision "ok" after the cooling credits the others and writes nothing of a deleting person', async () => {
        const frozen = await completedProject(rw.world, { prLines: 20 });
        const teamId = frozen.fx.team.id;
        expect((await creditRunRow(rw.world, teamId))?.status).toBe('frozen');
        await rw.world
          .sql`UPDATE auth."user" SET status = 'deleting' WHERE id = ${frozen.frontend.id}`;
        await endCooling(frozen);
        expect((await creditRunRow(rw.world, teamId))?.status).toBe('frozen');
        const caseId = (await openCaseOf(rw.world, rw.admin, teamId)).id;
        const comment = 'Проверено вручную: проект настоящий.';
        expectOk(
          'decideFraudCase',
          await decide(rw.world, rw.admin, caseId, 'ok', undefined, comment),
          200,
        );
        expect((await creditRunRow(rw.world, teamId))?.status).toBe('credited');
        expect((await projectCreditRows(rw.world, teamId)).map((r) => r.user_id).sort()).toEqual(
          [frozen.lead.id, frozen.backend.id].sort(),
        );
        expect(await creditsOf(rw.world, teamId, frozen.frontend.id)).toEqual([]);
        expect(await counterRowCount(rw.world, frozen.frontend.id)).toBe(0);
        expect(await awardRows(rw.world, frozen.frontend.id)).toEqual([]);
      }, 300_000);
    });
  },
);
