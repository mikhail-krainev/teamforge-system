import { afterAll, beforeAll, expect, it } from 'vitest';
import {
  completedProject,
  endCooling,
  waitCreditRun,
  type Project,
} from '../../../../test/fixtures/rewards.js';
import { describeInfra } from '../../../../test/helpers/infra.js';
import { startRewardsWorld, type RewardsWorld } from './support.js';

/*
 * S7-02 (written before the implementation): the facade `RewardsApi` of architecture 3.8 - what other modules
 * (matching, profiles) may call: getUserAwards(userId), getCounters(userId), getCreditStatus(teamId, userId).
 * The token is `REWARDS_API` in `public.ts` (the convention of PROFILES_API); it is read by name so that the
 * file compiles before the export exists. The shapes of the views are the implementation's; the tests check the
 * facts they must carry.
 */

interface RewardsApi {
  getUserAwards(userId: string): Promise<unknown[]>;
  getCounters(userId: string): Promise<{
    total: number;
    byRole: { roleCode: string; value: number }[];
    productTypes: string[];
  }>;
  getCreditStatus(teamId: string, userId: string): Promise<{ status: string } | null>;
}

describeInfra('S7 rewards: the facade RewardsApi (architecture 3.8)', ['db', 'redis', 's3'], () => {
  let rw: RewardsWorld;
  let project: Project;
  let api: RewardsApi;

  beforeAll(async () => {
    rw = await startRewardsWorld();
    const exported = (await import('../public.js')) as Record<string, unknown>;
    const token = exported['REWARDS_API'];
    if (token === undefined) throw new Error('rewards/public.ts does not export REWARDS_API');
    api = rw.world.app.get<RewardsApi>(token as string, { strict: false });
    project = await completedProject(rw.world);
  }, 240_000);

  afterAll(async () => {
    if (rw) await rw.close();
  });

  it('FR-REW-11: getCreditStatus is null for a project without a credit_run and for a stranger; "cooling" for a participant', async () => {
    const stranger = await rw.world.createUser('facade-stranger');
    expect(await api.getCreditStatus(project.fx.team.id, stranger.id)).toBeNull();
    expect(
      await api.getCreditStatus('00000000-0000-4000-8000-000000000999', project.lead.id),
    ).toBeNull();
    expect((await api.getCreditStatus(project.fx.team.id, project.backend.id))?.status).toBe(
      'cooling',
    );
  });

  it('FR-REW-04: before the credit the counters are zero and there are no awards', async () => {
    expect(await api.getCounters(project.backend.id)).toEqual({
      total: 0,
      byRole: [],
      productTypes: [],
    });
    expect(await api.getUserAwards(project.backend.id)).toEqual([]);
  });

  it('FR-REW-04, FR-REW-05: after the credit the facade gives the counters by role, the product type and the awards', async () => {
    await endCooling(project);
    await waitCreditRun(rw.world, project.fx.team.id, 'credited');
    const counters = await api.getCounters(project.backend.id);
    expect(counters.total).toBe(1);
    expect(counters.byRole).toEqual([{ roleCode: 'backend', value: 1 }]);
    expect(counters.productTypes).toHaveLength(1);
    expect((await api.getUserAwards(project.backend.id)).length).toBeGreaterThan(0);
    expect((await api.getCreditStatus(project.fx.team.id, project.backend.id))?.status).toBe(
      'credited',
    );
    expect(await api.getCounters(project.lead.id)).toMatchObject({ total: 0, byRole: [] });
  });
});
