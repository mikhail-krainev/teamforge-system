import { afterAll, beforeAll, expect, it } from 'vitest';
import {
  completedProject,
  endCooling,
  waitCreditRun,
  type Project,
} from '../../../../test/fixtures/rewards.js';
import { counterValue, projectCreditOf } from '../../../../test/fixtures/rewards-db.js';
import { describeInfra } from '../../../../test/helpers/infra.js';
import { startRewardsWorld, type RewardsWorld } from './support.js';

/*
 * S7-11: a change of the lead during the cooling. A completed team keeps its roster: the lead can neither leave nor be
 * replaced by a vote (`leader-vote-requests` is for `forming` and `active` teams only), and the credit at the end of
 * the cooling is the one of the frozen `project_completion` snapshot.
 */

describeInfra(
  'S7-11 rewards: no change of the lead during the cooling',
  ['db', 'redis', 's3'],
  () => {
    let rw: RewardsWorld;
    let project: Project;
    let leave: { statusCode: number; body: string };
    let voteRequest: { statusCode: number; body: string };

    beforeAll(async () => {
      rw = await startRewardsWorld();
      project = await completedProject(rw.world);
      const teamId = project.fx.team.id;
      leave = await rw.world.as(project.lead).delete(`/v1/teams/${teamId}/members/me`);
      voteRequest = await rw.world
        .as(project.backend)
        .post(`/v1/teams/${teamId}/leader-vote-requests`, {});
      expect((await endCooling(project))[0]?.state).toBe('completed');
      await waitCreditRun(rw.world, teamId, 'credited');
    }, 300_000);

    afterAll(async () => {
      if (rw) await rw.close();
    });

    it('the lead cannot leave the completed team and a member cannot ask for a new lead: 409 INVALID_STATE', () => {
      expect(leave.statusCode, leave.body).toBe(409);
      expect(JSON.parse(leave.body).code).toBe('INVALID_STATE');
      expect(voteRequest.statusCode, voteRequest.body).toBe(409);
      expect(JSON.parse(voteRequest.body).code).toBe('INVALID_STATE');
    });

    it('the developers are credited, the lead stays denied, as in the snapshot', async () => {
      const teamId = project.fx.team.id;
      expect((await projectCreditOf(rw.world, teamId, project.backend.id))?.status).toBe(
        'credited',
      );
      expect((await projectCreditOf(rw.world, teamId, project.frontend.id))?.status).toBe(
        'credited',
      );
      expect((await projectCreditOf(rw.world, teamId, project.lead.id))?.status).toBe('denied');
      expect(await counterValue(rw.world, project.backend.id)).toBe(1);
      expect(await counterValue(rw.world, project.lead.id)).toBe(0);
    });
  },
);
