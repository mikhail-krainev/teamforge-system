import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  completedProject,
  COOLING_MS,
  creditOk,
  endCooling,
  runCoolingEnd,
  runCreditScan,
  waitCreditRun,
  type Project,
  countersOk,
  awardsOk,
} from '../../../../test/fixtures/rewards.js';
import {
  creditRunCount,
  creditRunRow,
  projectCreditRows,
  rewardsOutbox,
} from '../../../../test/fixtures/rewards-db.js';
import { clockOf } from '../../../../test/fixtures/workspace.js';
import { describeInfra } from '../../../../test/helpers/infra.js';
import { startRewardsWorld, type RewardsWorld } from './support.js';

/*
 * S7-02 (written before the implementation): the credit_run of a completed project and its cooling
 * (FR-REW-11, FR-REW-15, AF-24; architecture 10.1). The event `workspace.project_completed` opens a `credit_run`
 * with status `cooling` and `cooling_until = completed_at + 7 days`; the timer `rewards-cooling-end` (jobId
 * `credit_<teamId>`) applies the credit after the cooling; the scanner `credit-run-scan` (every 10 minutes) repairs
 * a lost event. The races of these paths are in test/concurrency/cc-06-credit.test.ts.
 *
 * ASSUMPTIONS: the timer is the job `rewards-cooling-end` of the `timers` queue with data `{ teamId }`
 * (fixtures/rewards.ts `runCoolingEnd`); a timer that fires before `cooling_until` is a quiet no-op (the job may
 * end completed or failed, the state of the data is what is asserted).
 */

const TEN_MINUTES = 10 * 60_000;

describeInfra('S7 rewards: credit_run and the cooling (FR-REW-11, AF-24)', ['db', 'redis', 's3'], () => {
  let rw: RewardsWorld;
  let project: Project;

  beforeAll(async () => {
    rw = await startRewardsWorld();
    project = await completedProject(rw.world);
  }, 240_000);

  afterAll(async () => {
    if (rw) await rw.close();
  });

  const teamId = (): string => project.fx.team.id;

  it('FR-REW-11: the completion event opens one credit_run, cooling, with cooling_until = completed_at + 7 days', async () => {
    const run = await creditRunRow(rw.world, teamId());
    expect(run).toBeDefined();
    expect(run?.status).toBe('cooling');
    expect((run?.cooling_until.getTime() ?? 0) - (run?.completed_at.getTime() ?? 0)).toBe(COOLING_MS);
    expect(run?.completed_at.toISOString()).toBe(new Date(project.completion?.completedAt ?? '').toISOString());
    expect(run?.credited_at).toBeNull();
    expect(run?.roster_hash.length).toBe(32);
    expect(await creditRunCount(rw.world, teamId())).toBe(1);
  });

  it('FR-REW-11: getTeamCredit says cooling with the same date as the completion answer, to every participant', async () => {
    for (const member of [project.lead, project.backend, project.frontend]) {
      const credit = await creditOk(rw.world, member, teamId());
      expect(credit.teamId).toBe(teamId());
      expect(credit.status).toBe('cooling');
      expect(new Date(credit.coolingUntil).toISOString()).toBe(
        new Date(project.completion?.credit.coolingUntil ?? '').toISOString(),
      );
      expect(credit.myCredits.every((c) => c.status !== 'credited')).toBe(true);
    }
  });

  it('FR-REW-11, AF-24: during the cooling nothing is credited: no rows of project_credit, zero counters, no awards', async () => {
    expect(await projectCreditRows(rw.world, teamId())).toEqual([]);
    for (const member of [project.backend, project.frontend]) {
      expect((await countersOk(rw.world, project.lead, member.id)).total).toBe(0);
      expect(await awardsOk(rw.world, project.lead, member.id)).toEqual([]);
    }
  });

  it('FR-REW-11: the completion answer and the credit_run agree on the end of the cooling', async () => {
    const run = await creditRunRow(rw.world, teamId());
    expect(run?.cooling_until.toISOString()).toBe(
      new Date(project.completion?.credit.coolingUntil ?? '').toISOString(),
    );
  });

  it('FR-REW-11: the timer that fires before the end of the cooling changes nothing', async () => {
    await runCoolingEnd(rw.world, teamId());
    expect((await creditRunRow(rw.world, teamId()))?.status).toBe('cooling');
    expect(await projectCreditRows(rw.world, teamId())).toEqual([]);
  });

  it('FR-REW-11: the scanner credit-run-scan finds the credit_run of the completion and does not add a second one', async () => {
    clockOf(rw.world).advance(TEN_MINUTES + 60_000);
    await runCreditScan(rw.world);
    expect(await creditRunCount(rw.world, teamId())).toBe(1);
    expect((await creditRunRow(rw.world, teamId()))?.status).toBe('cooling');
  });

  it('FR-REW-11: a lost completion event - the scanner (older than 10 minutes) opens the credit_run, with the same dates', async () => {
    const lost = await completedProject(rw.world);
    const before = await creditRunRow(rw.world, lost.fx.team.id);
    await rw.world.sql`DELETE FROM rewards.credit_run WHERE team_id = ${lost.fx.team.id}`;
    clockOf(rw.world).advance(TEN_MINUTES + 60_000);
    await runCreditScan(rw.world);
    await waitCreditRun(rw.world, lost.fx.team.id, 'cooling');
    const after = await creditRunRow(rw.world, lost.fx.team.id);
    expect(after?.completed_at.toISOString()).toBe(before?.completed_at.toISOString());
    expect(after?.cooling_until.toISOString()).toBe(before?.cooling_until.toISOString());
    expect(await creditRunCount(rw.world, lost.fx.team.id)).toBe(1);
  }, 240_000);

  it('FR-REW-11: the scanner leaves a completion younger than 10 minutes to the event', async () => {
    const fresh = await completedProject(rw.world);
    await rw.world.sql`DELETE FROM rewards.credit_run WHERE team_id = ${fresh.fx.team.id}`;
    await runCreditScan(rw.world);
    expect(await creditRunCount(rw.world, fresh.fx.team.id)).toBe(0);
  }, 240_000);

  it('FR-REW-11, CC-6: after 7 days the timer credits the project: credit_run credited, credited_at set, one event per credited person', async () => {
    const outboxBefore = await rewardsOutbox(rw.world, 'credits_changed');
    const [outcome] = await endCooling(project);
    expect(outcome?.state).toBe('completed');
    await waitCreditRun(rw.world, teamId(), 'credited');
    const run = await creditRunRow(rw.world, teamId());
    expect(run?.credited_at).not.toBeNull();
    const credit = await creditOk(rw.world, project.backend, teamId());
    expect(credit.status).toBe('credited');
    expect(new Date(credit.coolingUntil).getTime()).toBe(run?.cooling_until.getTime());
    expect(await rewardsOutbox(rw.world, 'credits_changed')).toBeGreaterThanOrEqual(outboxBefore + 2);
  }, 120_000);

  it('FR-REW-11, AF-24: a second run of the timer after the credit changes nothing', async () => {
    const before = (await projectCreditRows(rw.world, teamId())).map((r) => `${r.user_id}:${r.status}`);
    const countersBefore = (await countersOk(rw.world, project.lead, project.backend.id)).total;
    await runCoolingEnd(rw.world, teamId());
    expect((await projectCreditRows(rw.world, teamId())).map((r) => `${r.user_id}:${r.status}`)).toEqual(before);
    expect((await countersOk(rw.world, project.lead, project.backend.id)).total).toBe(countersBefore);
    expect((await creditRunRow(rw.world, teamId()))?.status).toBe('credited');
  });
});
