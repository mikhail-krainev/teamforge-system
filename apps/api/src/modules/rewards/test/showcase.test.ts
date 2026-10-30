import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, expect, it } from 'vitest';
import {
  awardsOk,
  completedProject,
  countersOk,
  decide,
  endCooling,
  listBadges,
  waitCreditRun,
  userAwards,
  userCounters,
  type Project,
} from '../../../../test/fixtures/rewards.js';
import { clockOf } from '../../../../test/fixtures/workspace.js';
import { describeInfra } from '../../../../test/helpers/infra.js';
import { startRewardsWorld, type RewardsWorld } from './support.js';

/*
 * S7-06 (written before the implementation): "кэш витрины" (docs/plan.md S7-06; C-39 for the demand showcase, the
 * same rule here): the awards and the counters of a profile may be cached, but a credit or a revocation must show
 * at once - the cache is dropped by `rewards.credits_changed` / `award_revoked`, it is never served stale after
 * the change. The catalog of the badges is static and answers the same to every signed-in user.
 */

describeInfra(
  'S7 rewards: the showcase cache never serves a stale profile (FR-REW-04, FR-REW-05, FR-PROF-06)',
  ['db', 'redis', 's3'],
  () => {
    let rw: RewardsWorld;
    let project: Project;

    beforeAll(async () => {
      rw = await startRewardsWorld();
      project = await completedProject(rw.world);
    }, 240_000);

    afterAll(async () => {
      if (rw) await rw.close();
    });

    it('FR-REW-05: the catalog is the same for every user and for repeated calls', async () => {
      const first = await listBadges(rw.world, project.lead);
      const second = await listBadges(rw.world, project.backend);
      const third = await listBadges(rw.world, rw.admin);
      expect(first.statusCode).toBe(200);
      expect(second.json()).toEqual(first.json());
      expect(third.json()).toEqual(first.json());
    });

    it('FR-PROF-06: the awards and the counters are read twice (the cache is warm), then the credit comes: the next read shows it', async () => {
      for (let i = 0; i < 2; i += 1) {
        expect((await userAwards(rw.world, project.lead, project.backend.id)).statusCode).toBe(200);
        expect((await userCounters(rw.world, project.lead, project.backend.id)).statusCode).toBe(
          200,
        );
      }
      expect((await countersOk(rw.world, project.lead, project.backend.id)).total).toBe(0);
      await endCooling(project);
      await waitCreditRun(rw.world, project.fx.team.id, 'credited');
      expect((await countersOk(rw.world, project.lead, project.backend.id)).total).toBe(1);
      expect((await awardsOk(rw.world, project.lead, project.backend.id)).length).toBeGreaterThan(
        0,
      );
    });

    it('FR-REW-12: a violation drops the same cache: the next read of the awards and the counters shows the revoked state', async () => {
      const caseId = randomUUID();
      await rw.world.sql`
      INSERT INTO rewards.fraud_case (id, team_id, status, opened_at)
      VALUES (${caseId}, ${project.fx.team.id}, 'open', ${clockOf(rw.world).now()})`;
      expect(
        (await awardsOk(rw.world, project.frontend, project.backend.id)).length,
      ).toBeGreaterThan(0);
      const response = await decide(
        rw.world,
        rw.admin,
        caseId,
        'violation',
        undefined,
        'Отзыв: нарушение подтверждено вручную.',
      );
      expect(response.statusCode, response.body).toBe(200);
      expect((await countersOk(rw.world, project.frontend, project.backend.id)).total).toBe(0);
      expect(await awardsOk(rw.world, project.frontend, project.backend.id)).toEqual([]);
    });
  },
);
