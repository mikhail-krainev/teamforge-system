import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { UserFixture } from '../../../../test/fixtures/index.js';
import {
  buildProject,
  completedProject,
  contribute,
  countersOk,
  creditOk,
  endCooling,
  finishProject,
  joinLate,
  leaveEarly,
  membersOf,
  plantAccounts,
  relabelOneContribution,
  runCoolingEnd,
  runPendingRecheck,
  takeSecondRole,
  waitCreditRun,
  awardsOk,
  COOLING_MS,
  type Project,
} from '../../../../test/fixtures/rewards.js';
import {
  countersAgreeWithCredits,
  counterValue,
  creditRows,
  creditsOf,
  projectCreditOf,
  projectCreditRows,
  rewardsOutbox,
} from '../../../../test/fixtures/rewards-db.js';
import { clockOf } from '../../../../test/fixtures/workspace.js';
import { describeInfra } from '../../../../test/helpers/infra.js';
import { startRewardsWorld, type RewardsWorld } from './support.js';

/*
 * S7-04 (written before the implementation): who gets a credit and for which roles (FR-REW-01..04, FR-GH-09,
 * AF-16, CC-6 single run). Every scenario is a full project through the production path of slices 3-6 (a lead
 * without contributions, `backend` and `frontend` developers with work in each of the 3 stages of the mini playbook,
 * 28 days), then the cooling is passed and the timer `rewards-cooling-end` fires once.
 *
 * ASSUMPTIONS (the contract leaves them open):
 *   - a participant who is not credited has a `project_credit` row with status `denied` (the early leaver may have
 *     no row at all); the lead of the fixtures holds no seat role, so he has no `credit` rows and `myCredits` is
 *     empty or has no credited item for him;
 *   - `reason` of a denied or pending item is a non-empty text (the codes are the implementation's choice);
 *   - "participated in a stage" = was in the team in the window of the stage and has a contribution in it or is
 *     confirmed by the lead (FR-WORK-11); a stage counts from the opening to the closing of the route stage.
 */

const stagesNeeded = (total: number): number => Math.ceil(0.6 * total);

describeInfra('S7 rewards: the credit of a standard project (FR-REW-01..04)', ['db', 'redis', 's3'], () => {
  let rw: RewardsWorld;
  let project: Project;

  beforeAll(async () => {
    rw = await startRewardsWorld();
    project = await completedProject(rw.world);
    expect((await endCooling(project))[0]?.state).toBe('completed');
    await waitCreditRun(rw.world, project.fx.team.id, 'credited');
  }, 300_000);

  afterAll(async () => {
    if (rw) await rw.close();
  });

  const teamId = (): string => project.fx.team.id;

  it('FR-REW-01: the developers with a contribution in every stage are credited, the lead without any contribution is not', async () => {
    expect((await projectCreditOf(rw.world, teamId(), project.backend.id))?.status).toBe('credited');
    expect((await projectCreditOf(rw.world, teamId(), project.frontend.id))?.status).toBe('credited');
    const lead = await projectCreditOf(rw.world, teamId(), project.lead.id);
    expect(lead?.status).toBe('denied');
    expect(lead?.reason).toBeTruthy();
  });

  it('FR-REW-02: the credit is per role of the contribution: backend for the backend developer, frontend for the frontend one', async () => {
    expect((await creditsOf(rw.world, teamId(), project.backend.id)).map((c) => [c.role_code, c.status])).toEqual([
      ['backend', 'credited'],
    ]);
    expect((await creditsOf(rw.world, teamId(), project.frontend.id)).map((c) => [c.role_code, c.status])).toEqual([
      ['frontend', 'credited'],
    ]);
    expect(await creditsOf(rw.world, teamId(), project.lead.id)).toEqual([]);
  });

  it('FR-REW-04: the total counter and the counter of the role are +1; the product type is recorded', async () => {
    const counters = await countersOk(rw.world, project.lead, project.backend.id);
    expect(counters).toEqual({
      total: 1,
      byRole: [{ roleCode: 'backend', value: 1 }],
      productTypes: ['web_service'],
    });
    expect((await countersOk(rw.world, project.lead, project.frontend.id)).byRole).toEqual([
      { roleCode: 'frontend', value: 1 },
    ]);
    expect(await counterValue(rw.world, project.lead.id)).toBe(0);
  });

  it('FR-REW-04: the counters equal the credited rows behind them', async () => {
    for (const user of [project.backend, project.frontend, project.lead]) {
      expect(await countersAgreeWithCredits(rw.world, user.id)).toBe(true);
    }
  });

  it('FR-REW-01, FR-GH-09: getTeamCredit shows each participant his own credits by role (a participant sees his own, not the others)', async () => {
    const mine = await creditOk(rw.world, project.backend, teamId());
    expect(mine.status).toBe('credited');
    expect(mine.myCredits).toEqual([expect.objectContaining({ roleCode: 'backend', status: 'credited' })]);
    const lead = await creditOk(rw.world, project.lead, teamId());
    expect(lead.myCredits.every((c) => c.status !== 'credited')).toBe(true);
    expect(JSON.stringify(mine)).not.toContain(project.frontend.id);
  });

  it('FR-REW-01: a denied participant sees the reason of the refusal, and no signal of the anti-fraud rules', async () => {
    const response = await rw.world.as(project.lead).get(`/v1/teams/${teamId()}/credit`);
    expect(response.statusCode).toBe(200);
    expect(response.body).not.toMatch(/AF-\d{2}/);
  });

  it('FR-REW-04, CC-6: the credit sends credits_changed to matching: completed_count of the role is 1 for the backend developer', async () => {
    expect(await rewardsOutbox(rw.world, 'credits_changed')).toBeGreaterThanOrEqual(2);
    const rows = await rw.world.sql<{ completed_count: number }[]>`
      SELECT completed_count FROM matching.candidate_stats
       WHERE user_id = ${project.backend.id} AND role_code = 'backend'`;
    expect(rows[0]?.completed_count).toBe(1);
  });

  it('FR-REW-06: a repeated run of the credit leaves the rows and counters as they are', async () => {
    const before = JSON.stringify(await creditRows(rw.world, teamId()));
    await runCoolingEnd(rw.world, teamId(), 2);
    expect(JSON.stringify(await creditRows(rw.world, teamId()))).toBe(before);
    expect(await counterValue(rw.world, project.backend.id)).toBe(1);
  });
});

describeInfra('S7 rewards: roles of one person (FR-REW-02, FR-REW-03, C-03)', ['db', 'redis', 's3'], () => {
  let rw: RewardsWorld;
  let project: Project;
  let solo: UserFixture;
  let combined: UserFixture;

  beforeAll(async () => {
    rw = await startRewardsWorld();
    project = await buildProject(rw.world, {
      beforeStage: {
        2: async (p) => {
          // the backend developer holds a second seat and moves one contribution to it; the frontend developer
          // holds a second seat but works only under his own role
          combined = p.backend;
          solo = p.frontend;
          await takeSecondRole(p, p.backend, 'devops');
          await relabelOneContribution(p, p.backend, 'devops');
          await takeSecondRole(p, p.frontend, 'devops');
        },
      },
    });
    await finishProject(project);
    await endCooling(project);
    await waitCreditRun(rw.world, project.fx.team.id, 'credited');
  }, 300_000);

  afterAll(async () => {
    if (rw) await rw.close();
  });

  it('FR-REW-02: contributions under two labels (backend and devops) -> credit for both roles; the person counts once in the total', async () => {
    const credits = await creditsOf(rw.world, project.fx.team.id, combined.id);
    expect(credits.map((c) => [c.role_code, c.status])).toEqual([
      ['backend', 'credited'],
      ['devops', 'credited'],
    ]);
    const counters = await countersOk(rw.world, project.lead, combined.id);
    expect(counters.total).toBe(1);
    expect([...counters.byRole].sort((a, b) => a.roleCode.localeCompare(b.roleCode))).toEqual([
      { roleCode: 'backend', value: 1 },
      { roleCode: 'devops', value: 1 },
    ]);
  });

  it('FR-REW-02: two seats but every contribution labelled with one role -> credit only for that role, no counter for the other', async () => {
    const credits = await creditsOf(rw.world, project.fx.team.id, solo.id);
    expect(credits.map((c) => c.role_code)).toEqual(['frontend']);
    const counters = await countersOk(rw.world, project.lead, solo.id);
    expect(counters.total).toBe(1);
    expect(counters.byRole).toEqual([{ roleCode: 'frontend', value: 1 }]);
  });

  it('FR-REW-03: a seat that nobody works under (here: the second devops seat of the frontend developer) gives no credit', async () => {
    expect((await creditsOf(rw.world, project.fx.team.id, solo.id)).some((c) => c.role_code === 'devops')).toBe(false);
    expect(await counterValue(rw.world, solo.id, 'devops')).toBe(0);
  });
});

describeInfra('S7 rewards: the project the person left or joined late (FR-REW-01 (1), (3), FR-WORK-11)', ['db', 'redis', 's3'], () => {
  let rw: RewardsWorld;
  let project: Project;
  const people: Partial<Record<'leaver' | 'stage2' | 'confirmed' | 'unconfirmed' | 'stage3', UserFixture>> = {};

  beforeAll(async () => {
    rw = await startRewardsWorld();
    project = await buildProject(rw.world, {
      beforeStage: {
        2: async (p) => {
          // joins at the opening of stage 2, works in stages 2 and 3: 2 of 3 stages = ceil(0.6 * 3)
          people.stage2 = await joinLate(p, 'devops', { contributes: 1 });
          // joins at the opening of stage 2, confirmed by the lead for stage 2, works in stage 3 only: 2 of 3
          people.confirmed = await joinLate(p, 'devops');
          const confirmed = await p.world.as(p.lead).post(`/v1/teams/${p.fx.team.id}/participation-confirmations`, {
            userId: people.confirmed.id,
            stageOrdinal: 2,
          });
          expect(confirmed.statusCode, confirmed.body).toBe(201);
          // joins at the opening of stage 2, no confirmation, works in stage 3 only: 1 of 3
          people.unconfirmed = await joinLate(p, 'devops');
          // joins, works and leaves before the completion
          people.leaver = await joinLate(p, 'devops', { contributes: 2 });
        },
        3: async (p) => {
          for (const who of [people.stage2, people.confirmed, people.unconfirmed]) {
            if (!who) throw new Error('fixture');
            await contribute(p, who, 1);
          }
          // joins at the opening of stage 3: 1 of 3
          people.stage3 = await joinLate(p, 'devops', { contributes: 1 });
        },
      },
      beforeCompletion: async (p) => {
        if (!people.leaver) throw new Error('fixture');
        await leaveEarly(p, people.leaver);
      },
    });
    await finishProject(project);
    await endCooling(project);
    await waitCreditRun(rw.world, project.fx.team.id, 'credited');
  }, 420_000);

  afterAll(async () => {
    if (rw) await rw.close();
  });

  const status = async (who: UserFixture | undefined): Promise<string | undefined> =>
    who ? (await projectCreditOf(rw.world, project.fx.team.id, who.id))?.status : undefined;

  it('FR-REW-01 (3): the number of stages needed is ceil(0.6 * stages): 3 stages -> 2', () => {
    expect(stagesNeeded(3)).toBe(2);
  });

  it('FR-REW-01 (1): a member who left before the completion gets no credit and no counter', async () => {
    expect([undefined, 'denied']).toContain(await status(people.leaver));
    expect(await counterValue(rw.world, people.leaver?.id ?? '')).toBe(0);
    expect((await creditsOf(rw.world, project.fx.team.id, people.leaver?.id ?? '')).every((c) => c.status !== 'credited')).toBe(true);
  });

  it('FR-REW-01 (3): present in 2 of 3 stages with a contribution in each -> credited', async () => {
    expect(await status(people.stage2)).toBe('credited');
  });

  it('FR-REW-01 (3), FR-WORK-11: present in 2 of 3 stages, one of them confirmed by the lead -> credited', async () => {
    expect(await status(people.confirmed)).toBe('credited');
  });

  it('FR-REW-01 (3): present in 2 stages but a contribution in 1 and no confirmation -> denied with a reason', async () => {
    expect(await status(people.unconfirmed)).toBe('denied');
    expect((await projectCreditOf(rw.world, project.fx.team.id, people.unconfirmed?.id ?? ''))?.reason).toBeTruthy();
  });

  it('FR-REW-01 (3): joined at the last stage, 1 of 3 -> denied, counters unchanged', async () => {
    expect(await status(people.stage3)).toBe('denied');
    expect(await counterValue(rw.world, people.stage3?.id ?? '')).toBe(0);
  });

  it('FR-REW-01: the denied member sees why in getTeamCredit (status denied, reason), the credited ones see credited', async () => {
    const denied = await creditOk(rw.world, people.stage3 ?? project.lead, project.fx.team.id);
    expect(denied.myCredits.every((c) => c.status === 'denied')).toBe(true);
    expect(denied.myCredits.every((c) => Boolean(c.reason))).toBe(true);
    const credited = await creditOk(rw.world, people.stage2 ?? project.lead, project.fx.team.id);
    expect(credited.myCredits).toEqual([expect.objectContaining({ roleCode: 'devops', status: 'credited' })]);
  });

  it('FR-REW-04: the people credited are counted once each; the invariant of counters holds for all', async () => {
    for (const user of membersOf(project)) {
      expect(await countersAgreeWithCredits(rw.world, user.id)).toBe(true);
    }
    expect((await projectCreditRows(rw.world, project.fx.team.id)).filter((r) => r.status === 'credited').length).toBe(4);
  });
});

describeInfra('S7 rewards: the age of the GitHub account (FR-GH-09, AF-16, pending_account)', ['db', 'redis', 's3'], () => {
  let rw: RewardsWorld;
  let project: Project;

  beforeAll(async () => {
    rw = await startRewardsWorld();
    project = await completedProject(rw.world);
    await plantAccounts(rw.world, [project.lead, project.frontend]);
    await plantAccounts(rw.world, [project.backend], { ageDays: 5 });
    clockOf(rw.world).advance(COOLING_MS + 3_600_000);
    await runCoolingEnd(rw.world, project.fx.team.id);
    await waitCreditRun(rw.world, project.fx.team.id, 'credited');
  }, 300_000);

  afterAll(async () => {
    if (rw) await rw.close();
  });

  const teamId = (): string => project.fx.team.id;

  it('FR-GH-09, AF-16: an account younger than 30 days -> pending_account, not denied; the others are credited', async () => {
    expect((await projectCreditOf(rw.world, teamId(), project.backend.id))?.status).toBe('pending_account');
    expect((await projectCreditOf(rw.world, teamId(), project.frontend.id))?.status).toBe('credited');
    expect((await creditsOf(rw.world, teamId(), project.backend.id)).map((c) => c.status)).toEqual(['pending_account']);
  });

  it('FR-GH-09: the pending member sees the status and a reason; counters and awards wait', async () => {
    const credit = await creditOk(rw.world, project.backend, teamId());
    expect(credit.myCredits).toEqual([expect.objectContaining({ roleCode: 'backend', status: 'pending_account' })]);
    expect(credit.myCredits[0]?.reason).toBeTruthy();
    expect((await countersOk(rw.world, project.lead, project.backend.id)).total).toBe(0);
    expect(await awardsOk(rw.world, project.lead, project.backend.id)).toEqual([]);
  });

  it('FR-GH-09: the daily pending-account-recheck with the account still young changes nothing', async () => {
    await runPendingRecheck(rw.world);
    expect((await projectCreditOf(rw.world, teamId(), project.backend.id))?.status).toBe('pending_account');
    expect((await countersOk(rw.world, project.lead, project.backend.id)).total).toBe(0);
  });

  it('FR-GH-09: when the account has grown up the recheck credits the member: counters +1 and awards, once', async () => {
    await plantAccounts(rw.world, [project.backend]);
    await runPendingRecheck(rw.world, 2);
    expect((await projectCreditOf(rw.world, teamId(), project.backend.id))?.status).toBe('credited');
    expect(await counterValue(rw.world, project.backend.id)).toBe(1);
    expect(await counterValue(rw.world, project.backend.id, 'backend')).toBe(1);
    expect((await awardsOk(rw.world, project.lead, project.backend.id)).length).toBeGreaterThan(0);
    await runPendingRecheck(rw.world);
    expect(await counterValue(rw.world, project.backend.id)).toBe(1);
  });

  it('FR-GH-09: no public repository and no public activity counts as not ready, however old the account is', async () => {
    const quiet = await completedProject(rw.world);
    await plantAccounts(rw.world, [quiet.lead, quiet.frontend]);
    await plantAccounts(rw.world, [quiet.backend], { ageDays: 400, publicRepos: 0, publicActivity: false });
    clockOf(rw.world).advance(COOLING_MS + 3_600_000);
    await runCoolingEnd(rw.world, quiet.fx.team.id);
    await waitCreditRun(rw.world, quiet.fx.team.id, 'credited');
    expect((await projectCreditOf(rw.world, quiet.fx.team.id, quiet.backend.id))?.status).toBe('pending_account');
  }, 300_000);
});
