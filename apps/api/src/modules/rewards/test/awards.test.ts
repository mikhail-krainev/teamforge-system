import { afterAll, beforeAll, expect, it } from 'vitest';
import type { UserFixture } from '../../../../test/fixtures/index.js';
import {
  awardNames,
  awardsOk,
  BADGE_NAMES,
  buildProject,
  completedProject,
  contribute,
  countersOk,
  endCooling,
  finishProject,
  joinLate,
  leaveEarly,
  markDesired,
  plantAccounts,
  plantDeficit,
  plantHistory,
  runPendingRecheck,
  waitCreditRun,
  type Project,
} from '../../../../test/fixtures/rewards.js';
import {
  counterValue,
  fraudCaseRows,
  fraudSignalRows,
  projectCreditOf,
  teamAwardRows,
  activeAwardNames,
  creditRunRow,
} from '../../../../test/fixtures/rewards-db.js';
import { describeInfra } from '../../../../test/helpers/infra.js';
import { startRewardsWorld, type RewardsWorld } from './support.js';

/*
 * S7-04 (written before the implementation): the awards of the credit transaction (FR-REW-05..10, FR-REW-14;
 * architecture 10.3). Awards are looked up by their NAME in the table of FR-REW-05; the codes of `badge_def`
 * are the implementation's. History that a series needs (3rd, 5th project; three on-time in a row) is planted
 * in the rewards tables by `plantHistory` (fixtures/rewards.ts): one real project then crosses the threshold.
 *
 * ASSUMPTIONS: "Проекты" counts DISTINCT `roster_hash` of the credited projects of the user, so projects with the
 * same team composition count as one for the series, while the total counter still counts each (FR-REW-04, AF-13);
 * all steps reached and not yet awarded are given at once; the team badge has `scope=team` and carries the team.
 */

const FIRST = BADGE_NAMES.projects[0];
const THREE = BADGE_NAMES.projects[1];

describeInfra('S7 rewards: awards of a standard on-time project (FR-REW-05, FR-REW-07)', ['db', 'redis', 's3'], () => {
  let rw: RewardsWorld;
  let project: Project;

  beforeAll(async () => {
    rw = await startRewardsWorld();
    project = await completedProject(rw.world);
    await plantDeficit(rw.world, project.fx.team.id, project.backend, false);
    await plantDeficit(rw.world, project.fx.team.id, project.frontend, false);
    await endCooling(project);
    await waitCreditRun(rw.world, project.fx.team.id, 'credited');
  }, 300_000);

  afterAll(async () => {
    if (rw) await rw.close();
  });

  it('FR-REW-05: the first credited project gives the first step of "Проекты" with the project and the date', async () => {
    const awards = await awardsOk(rw.world, project.lead, project.backend.id);
    const first = awards.find((a) => a.name === FIRST);
    expect(first).toMatchObject({
      series: 'projects',
      step: 1,
      teamId: project.fx.team.id,
      teamName: project.fx.team.dto.name,
    });
    expect(Number.isNaN(Date.parse(first?.awardedAt ?? ''))).toBe(false);
  });

  it('FR-REW-07: a project without delay gives "В срок" to every credited participant', async () => {
    for (const user of [project.backend, project.frontend]) {
      expect(awardNames(await awardsOk(rw.world, project.lead, user.id))).toEqual([BADGE_NAMES.onTime, FIRST].sort());
    }
  });

  it('FR-REW-05: no series step beyond the first, no roles or product types series after one project in one role', async () => {
    const names = await activeAwardNames(rw.world, project.backend.id);
    for (const other of [THREE, ...BADGE_NAMES.roles, ...BADGE_NAMES.productTypes, BADGE_NAMES.streak, BADGE_NAMES.deficit]) {
      expect(names).not.toContain(other);
    }
  });

  it('FR-REW-01, FR-REW-07: the lead without credit has no individual award', async () => {
    expect(await awardsOk(rw.world, project.lead, project.lead.id)).toEqual([]);
  });

  it('FR-REW-06: the awards are unique per (user, badge): a repeated run adds none', async () => {
    const before = awardNames(await awardsOk(rw.world, project.lead, project.backend.id));
    await runPendingRecheck(rw.world);
    expect(awardNames(await awardsOk(rw.world, project.lead, project.backend.id))).toEqual(before);
  });
});

describeInfra('S7 rewards: a late project (FR-REW-07, FR-REW-08)', ['db', 'redis', 's3'], () => {
  let rw: RewardsWorld;
  let project: Project;

  beforeAll(async () => {
    rw = await startRewardsWorld();
    project = await completedProject(rw.world, { daysBeforeFinish: 40 });
    // the joining of the fixture records deficit_at_join = true (one open seat, nobody queued); this scenario is about delay
    await plantDeficit(rw.world, project.fx.team.id, project.frontend, false);
    await plantHistory(rw.world, project.backend, [
      { roles: ['backend'], completedDaysAgo: 300, overdueDays: 0 },
      { roles: ['backend'], completedDaysAgo: 200, overdueDays: 0 },
    ]);
    await endCooling(project);
    await waitCreditRun(rw.world, project.fx.team.id, 'credited');
  }, 300_000);

  afterAll(async () => {
    if (rw) await rw.close();
  });

  it('FR-REW-07: the delay is positive -> no "В срок"; the credit itself is given', async () => {
    const [row] = await rw.world.sql<{ overdue_days: number }[]>`
      SELECT overdue_days FROM rewards.project_credit WHERE team_id = ${project.fx.team.id} AND user_id = ${project.frontend.id}`;
    expect(row?.overdue_days).toBeGreaterThan(0);
    expect(awardNames(await awardsOk(rw.world, project.lead, project.frontend.id))).toEqual([FIRST]);
  });

  it('FR-REW-08: a late project breaks the series "Три в срок подряд" although two on-time projects precede it', async () => {
    const names = awardNames(await awardsOk(rw.world, project.lead, project.backend.id));
    expect(names).not.toContain(BADGE_NAMES.streak);
    expect(names).not.toContain(BADGE_NAMES.onTime);
    expect(names).toContain(THREE);
  });
});

describeInfra('S7 rewards: series, streak and identical rosters (FR-REW-04, FR-REW-05, FR-REW-08, AF-13)', ['db', 'redis', 's3'], () => {
  let rw: RewardsWorld;
  let project: Project;
  let streaker: UserFixture;
  let broken: UserFixture;
  let sameRoster: UserFixture;

  beforeAll(async () => {
    rw = await startRewardsWorld();
    project = await completedProject(rw.world, {
      beforeStage: {
        2: async (p) => {
          sameRoster = await joinLate(p, 'devops', { contributes: 1 });
        },
        3: async (p) => {
          await contribute(p, sameRoster, 1);
        },
      },
    });
    streaker = project.backend;
    broken = project.frontend;
    const w = rw.world;
    // backend: two earlier on-time projects with different teams -> the third project and the third on-time in a row
    await plantHistory(w, streaker, [
      { roles: ['backend'], completedDaysAgo: 300 },
      { roles: ['backend'], completedDaysAgo: 200 },
    ]);
    // frontend: a late project in between breaks the streak; two other roles and another product type give the
    // series "Роли" (3 roles) and "Типы продукта" (2 types)
    await plantHistory(w, broken, [
      { roles: ['pm'], completedDaysAgo: 300, productType: 'ml_service' },
      { roles: ['designer'], completedDaysAgo: 200, overdueDays: 4 },
    ]);
    // devops joiner: two earlier projects of ONE identical team composition: the total counts 3, the series 2
    await plantHistory(w, sameRoster, [
      { roles: ['devops'], completedDaysAgo: 300, roster: 'same-team-x' },
      { roles: ['devops'], completedDaysAgo: 200, roster: 'same-team-x' },
    ]);
    // a denied project of the streaker's neighbour does not break his chain (checked on `sameRoster` below)
    await plantHistory(w, sameRoster, [{ roles: ['devops'], completedDaysAgo: 100, status: 'denied', overdueDays: 9 }]);
    await endCooling(project);
    await waitCreditRun(w, project.fx.team.id, 'credited');
  }, 300_000);

  afterAll(async () => {
    if (rw) await rw.close();
  });

  const names = async (user: UserFixture): Promise<string[]> =>
    awardNames(await awardsOk(rw.world, project.lead, user.id));

  it('FR-REW-05: the third credited project gives the steps 1 and 2 of "Проекты" (all reached steps not yet awarded)', async () => {
    expect(await names(streaker)).toEqual(expect.arrayContaining([FIRST, THREE]));
    expect((await countersOk(rw.world, project.lead, streaker.id)).total).toBe(3);
  });

  it('FR-REW-08: the last three credited projects on time -> "Три в срок подряд"', async () => {
    expect(await names(streaker)).toContain(BADGE_NAMES.streak);
  });

  it('FR-REW-08: a late project among the last three -> no streak, but "В срок" for this project', async () => {
    const got = await names(broken);
    expect(got).not.toContain(BADGE_NAMES.streak);
    expect(got).toContain(BADGE_NAMES.onTime);
  });

  it('FR-REW-05: credit in 3 different roles -> "Многоликий" (the roles are counted over credited credits)', async () => {
    expect(await names(broken)).toContain(BADGE_NAMES.roles[0]);
    expect(await names(streaker)).not.toContain(BADGE_NAMES.roles[0]);
  });

  it('FR-REW-05: two different product types -> "Разные берега"; one type -> none; the 4th step is not given', async () => {
    expect(await names(broken)).toContain(BADGE_NAMES.productTypes[0]);
    expect(await names(streaker)).not.toContain(BADGE_NAMES.productTypes[0]);
    expect(await names(broken)).not.toContain(BADGE_NAMES.productTypes[1]);
  });

  it('FR-REW-04, AF-13: projects with an identical team composition count as one for "Проекты", each +1 for the counter', async () => {
    expect((await countersOk(rw.world, project.lead, sameRoster.id)).total).toBe(3);
    const got = await names(sameRoster);
    expect(got).toContain(FIRST);
    expect(got).not.toContain(THREE);
  });

  it('FR-REW-08: a project without credit between does not interrupt the chain of credited ones', async () => {
    // sameRoster: credited chain = planted 300, planted 200, this project (all on time); the denied late one is skipped
    expect(await names(sameRoster)).toContain(BADGE_NAMES.streak);
  });
});

describeInfra('S7 rewards: "Закрыл дефицит" and the team bonus "Закрытая вакансия" (FR-REW-09, FR-REW-10, AF-14)', ['db', 'redis', 's3'], () => {
  let rw: RewardsWorld;
  let project: Project;
  let leaver: UserFixture;
  const team = (): string => project.fx.team.id;

  beforeAll(async () => {
    rw = await startRewardsWorld();
    project = await buildProject(rw.world, {
      beforeStage: {
        2: async (p) => {
          // the backend seat is desired from the start of stage 2 (more than 7 days before the completion)
          await markDesired(p, 'backend');
          leaver = await joinLate(p, 'devops', { contributes: 1 });
        },
      },
      beforeCompletion: async (p) => {
        await plantDeficit(p.world, p.fx.team.id, p.backend, true);
        await plantDeficit(p.world, p.fx.team.id, p.frontend, false);
        await leaveEarly(p, leaver);
      },
    });
    await finishProject(project);
    // the frontend developer's account is too young: he is pending_account, the team bonus still reaches him
    await plantAccounts(rw.world, [project.lead, project.backend]);
    await plantAccounts(rw.world, [project.frontend], { ageDays: 3 });
    await endCooling(project, { plant: false });
    await waitCreditRun(rw.world, team(), 'credited');
  }, 300_000);

  afterAll(async () => {
    if (rw) await rw.close();
  });

  const names = async (user: UserFixture): Promise<string[]> =>
    awardNames(await awardsOk(rw.world, project.lead, user.id));

  it('FR-REW-09: the holder of a role with deficit_at_join=true and a credit gets "Закрыл дефицит"; the other developer does not', async () => {
    expect(await names(project.backend)).toContain(BADGE_NAMES.deficit);
    expect(await activeAwardNames(rw.world, project.frontend.id)).not.toContain(BADGE_NAMES.deficit);
  });

  it('FR-REW-10: the desired role is held by a credited member with deficit_at_join -> "Закрытая вакансия" for every member of the team, including the lead without a credit', async () => {
    for (const user of [project.lead, project.backend, project.frontend]) {
      expect(await names(user), user.displayName).toContain(BADGE_NAMES.teamBonus);
    }
    const bonus = (await teamAwardRows(rw.world, team())).filter((a) => a.scope === 'team');
    expect(bonus).toHaveLength(3);
    expect(new Set(bonus.map((a) => a.user_id))).toEqual(new Set([project.lead.id, project.backend.id, project.frontend.id]));
  });

  it('FR-REW-10: the member who left before the completion does not get the bonus', async () => {
    expect(await activeAwardNames(rw.world, leaver.id)).not.toContain(BADGE_NAMES.teamBonus);
  });

  it('FR-REW-10, pending_account: the bonus does not wait for the own credit; the individual awards of the pending member do', async () => {
    expect((await projectCreditOf(rw.world, team(), project.frontend.id))?.status).toBe('pending_account');
    expect(await names(project.frontend)).toEqual([BADGE_NAMES.teamBonus]);
    expect(await counterValue(rw.world, project.frontend.id)).toBe(0);
  });

  it('FR-GH-09, FR-REW-06: when the pending member is credited he gets his individual awards and counters, the bonus is not doubled', async () => {
    await plantAccounts(rw.world, [project.frontend]);
    await runPendingRecheck(rw.world, 2);
    const got = await names(project.frontend);
    expect(got).toEqual([FIRST, BADGE_NAMES.onTime, BADGE_NAMES.teamBonus].sort());
    expect(await counterValue(rw.world, project.frontend.id)).toBe(1);
    expect((await teamAwardRows(rw.world, team())).filter((a) => a.user_id === project.frontend.id && a.scope === 'team')).toHaveLength(1);
  });

  it('FR-REW-10, AF-14: a desired mark set long before the completion gives no signal AF-14', async () => {
    expect((await fraudSignalRows(rw.world, team())).map((s) => s.rule_code)).not.toContain('AF-14');
  });
});

describeInfra('S7 rewards: no team bonus without the whole condition (FR-REW-10)', ['db', 'redis', 's3'], () => {
  let rw: RewardsWorld;
  let project: Project;

  beforeAll(async () => {
    rw = await startRewardsWorld();
    project = await buildProject(rw.world, {
      beforeStage: {
        2: async (p) => {
          // devops: desired and with deficit, but nobody works under it -> not credited
          await joinLate(p, 'devops');
          await markDesired(p, 'frontend'); // desired, held by a credited member, but NO deficit_at_join
          await markDesired(p, 'devops'); // desired, deficit, but the holder has no contribution -> no credit
        },
      },
      beforeCompletion: async (p) => {
        await plantDeficit(p.world, p.fx.team.id, p.frontend, false);
        await plantDeficit(p.world, p.fx.team.id, p.backend, true); // deficit and credited, but the backend seat is not desired
        const devops = p.joined[0];
        if (devops) await plantDeficit(p.world, p.fx.team.id, devops, true);
      },
    });
    await finishProject(project);
    await endCooling(project);
    await waitCreditRun(rw.world, project.fx.team.id, 'credited');
  }, 300_000);

  afterAll(async () => {
    if (rw) await rw.close();
  });

  it('FR-REW-10: desired without deficit, deficit without desired, and deficit+desired without a credit give no bonus', async () => {
    expect((await teamAwardRows(rw.world, project.fx.team.id)).filter((a) => a.scope === 'team')).toEqual([]);
    for (const user of [project.lead, project.backend, project.frontend]) {
      expect(await activeAwardNames(rw.world, user.id)).not.toContain(BADGE_NAMES.teamBonus);
    }
  });

  it('FR-REW-09: the deficit award follows the credit of the holder only: the backend developer has it, the uncredited devops holder does not', async () => {
    expect(await activeAwardNames(rw.world, project.backend.id)).toContain(BADGE_NAMES.deficit);
    const devops = project.joined[0];
    expect(await activeAwardNames(rw.world, devops?.id ?? '')).not.toContain(BADGE_NAMES.deficit);
  });
});

describeInfra('S7 rewards: the mark set shortly before the completion (FR-REW-10, AF-14)', ['db', 'redis', 's3'], () => {
  let rw: RewardsWorld;
  let project: Project;

  beforeAll(async () => {
    rw = await startRewardsWorld();
    project = await buildProject(rw.world, {
      beforeCompletion: async (p) => {
        await markDesired(p, 'backend'); // less than C-17 = 7 days before the completion
        await plantDeficit(p.world, p.fx.team.id, p.backend, true);
      },
    });
    await finishProject(project);
    await endCooling(project);
    await waitCreditRun(rw.world, project.fx.team.id, 'credited');
  }, 300_000);

  afterAll(async () => {
    if (rw) await rw.close();
  });

  it('AF-14: a signal of +1 is recorded; it alone (below C-61 = 3) does not freeze the project', async () => {
    const signal = (await fraudSignalRows(rw.world, project.fx.team.id)).find((s) => s.rule_code === 'AF-14');
    expect(signal).toMatchObject({ action: 'signal', score: 1 });
    expect((await creditRunRow(rw.world, project.fx.team.id))?.status).toBe('credited');
    expect(await fraudCaseRows(rw.world, project.fx.team.id)).toEqual([]);
  });

  it('FR-REW-10: the signal does not cancel the bonus', async () => {
    for (const user of [project.lead, project.backend, project.frontend]) {
      expect(await activeAwardNames(rw.world, user.id)).toContain(BADGE_NAMES.teamBonus);
    }
  });
});
