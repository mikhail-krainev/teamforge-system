import { afterAll, beforeAll, expect, it } from 'vitest';
import { complete, runCheck } from '../fixtures/completion.js';
import {
  awardsOk,
  buildProject,
  completedProject,
  countersOk,
  creditRunStatus,
  endCooling,
  extraWorkers,
  finishProject,
  markDesired,
  membersOf,
  plantAccounts,
  plantDeficit,
  plantHistory,
  runCoolingEnd,
  runCreditScan,
  runPendingRecheck,
  waitCreditRun,
  COOLING_MS,
  type JobOutcome,
  type Project,
} from '../fixtures/rewards.js';
import {
  awardRows,
  counterValue,
  countersAgreeWithCredits,
  creditRows,
  creditRunCount,
  creditRunRow,
  projectCreditRows,
  rewardsOutbox,
  teamAwardRows,
} from '../fixtures/rewards-db.js';
import { expectNoDeadlocks } from '../fixtures/teams-db.js';
import { clockOf } from '../fixtures/workspace.js';
import { describeInfra, waitFor } from '../helpers/infra.js';
import { startRewardsWorld, type RewardsWorld } from '../fixtures/rewards-world.js';

/*
 * CC-6, the credit of a project (FR-REW-04, FR-REW-06, FR-REW-11; docs/plan.md S7-04, S7-02; architecture 10.2, 12.2).
 * `creditProject(teamId)` is the job `rewards-cooling-end` (jobId `credit_<teamId>`): lock #11 `credit_run FOR UPDATE`,
 * status `cooling`, inserts `ON CONFLICT DO NOTHING RETURNING`, counters by `RETURNING`, unique `credit` PK,
 * `counter_uq`, `award_*_uq`. Ten jobs run at once on three workers (one of the world and two more, started only for the burst: a worker
 * without the GitHub double cannot serve the checks of a project that is still being built), as ten parallel
 * `creditProject(teamId)` calls would. The job payload is the assumption of fixtures/rewards.ts. Races of the
 * decision of an administrator are in cc-12-fraud-decision.test.ts.
 */

const N = 10;

describeInfra(
  'CC-6: ten parallel credits of one project (FR-REW-04, FR-REW-06)',
  ['db', 'redis', 's3'],
  () => {
    let rw: RewardsWorld;
    let deadlocksBefore = 0;

    beforeAll(async () => {
      rw = await startRewardsWorld();
      deadlocksBefore = await rw.world.deadlocks();
    }, 120_000);

    afterAll(async () => {
      if (!rw) return;
      await expectNoDeadlocks(rw.world, deadlocksBefore);
      await rw.close();
    });

    /** Two more workers for the duration of a burst of jobs. */
    async function withWorkers<T>(burst: () => Promise<T>): Promise<T> {
      const extra = await extraWorkers(rw.world, 2);
      try {
        return await burst();
      } finally {
        await extra.close();
      }
    }

    const duplicateAwards = async (userId: string): Promise<number> => {
      const rows = await rw.world.sql<{ n: number }[]>`
      SELECT count(*)::int AS n FROM (
        SELECT badge_code, coalesce(team_id::text, '') AS team FROM rewards.award
         WHERE user_id = ${userId} AND revoked_at IS NULL
         GROUP BY badge_code, scope, coalesce(team_id::text, '') HAVING count(*) > 1) d`;
      return rows[0]?.n ?? 0;
    };

    const standing = async (project: Project): Promise<string> =>
      JSON.stringify({
        run: (await creditRunRow(rw.world, project.fx.team.id))?.status,
        projects: (await projectCreditRows(rw.world, project.fx.team.id)).map(
          (r) => `${r.user_id}:${r.status}`,
        ),
        credits: (await creditRows(rw.world, project.fx.team.id)).map(
          (r) => `${r.user_id}:${r.role_code}:${r.status}`,
        ),
        counters: await Promise.all(membersOf(project).map((m) => counterValue(rw.world, m.id))),
        awards: await Promise.all(
          membersOf(project).map(async (m) => (await awardRows(rw.world, m.id)).length),
        ),
      });

    it('CC-6: 10 parallel credits -> credit_run credited once, every credited person +1 in the total and in his role, no duplicate award', async () => {
      const project = await completedProject(rw.world);
      const eventsBefore = await rewardsOutbox(rw.world, 'credits_changed');
      const outcomes = await withWorkers(() => endCooling(project, { count: N }));
      expect(outcomes).toHaveLength(N);
      expect(outcomes.some((o) => o.state === 'completed')).toBe(true);
      await waitCreditRun(rw.world, project.fx.team.id, 'credited');

      const run = await creditRunRow(rw.world, project.fx.team.id);
      expect(run?.status).toBe('credited');
      expect(run?.credited_at).not.toBeNull();
      expect(await creditRunCount(rw.world, project.fx.team.id)).toBe(1);
      expect(
        (await projectCreditRows(rw.world, project.fx.team.id)).map((r) => r.user_id).sort(),
      ).toEqual(
        membersOf(project)
          .map((m) => m.id)
          .sort(),
      );
      for (const developer of [project.backend, project.frontend]) {
        expect(await counterValue(rw.world, developer.id), developer.displayName).toBe(1);
        expect(await countersAgreeWithCredits(rw.world, developer.id)).toBe(true);
        expect(await duplicateAwards(developer.id)).toBe(0);
      }
      expect(await counterValue(rw.world, project.lead.id)).toBe(0);
      expect(await rewardsOutbox(rw.world, 'credits_changed')).toBe(eventsBefore + 2);
      expect(
        (await creditRows(rw.world, project.fx.team.id)).filter((c) => c.status === 'credited'),
      ).toHaveLength(2);
    }, 300_000);

    it('CC-6 (paired): a second burst of 10 after the credit changes nothing: rows, counters, awards and events as they were', async () => {
      const project = await completedProject(rw.world);
      await endCooling(project, { count: 3 });
      await waitCreditRun(rw.world, project.fx.team.id, 'credited');
      const before = await standing(project);
      const eventsBefore = await rewardsOutbox(rw.world, 'credits_changed');
      const outcomes = await withWorkers(() => runCoolingEnd(rw.world, project.fx.team.id, N));
      expect(outcomes).toHaveLength(N);
      expect(await standing(project)).toBe(before);
      expect(await rewardsOutbox(rw.world, 'credits_changed')).toBe(eventsBefore);
      expect((await countersOk(rw.world, project.lead, project.backend.id)).total).toBe(1);
    }, 300_000);

    it('CC-6: the series and the team bonus are given once under 10 parallel credits: the 3rd project "Трое в строю", "Закрытая вакансия" for each of the three', async () => {
      const project = await buildProject(rw.world, {
        beforeStage: { 2: (p) => markDesired(p, 'backend') },
        beforeCompletion: (p) => plantDeficit(p.world, p.fx.team.id, p.backend, true),
      });
      await finishProject(project);
      await plantHistory(rw.world, project.backend, [
        { roles: ['backend'], completedDaysAgo: 300 },
        { roles: ['backend'], completedDaysAgo: 200 },
      ]);
      await withWorkers(() => endCooling(project, { count: N }));
      await waitCreditRun(rw.world, project.fx.team.id, 'credited');
      expect(await counterValue(rw.world, project.backend.id)).toBe(3);
      expect(await duplicateAwards(project.backend.id)).toBe(0);
      const names = (await awardsOk(rw.world, project.lead, project.backend.id)).map((a) => a.name);
      expect(names.filter((n) => n === 'Трое в строю')).toHaveLength(1);
      const bonus = (await teamAwardRows(rw.world, project.fx.team.id)).filter(
        (a) => a.scope === 'team',
      );
      expect(bonus).toHaveLength(3);
      expect(new Set(bonus.map((a) => a.user_id)).size).toBe(3);
    }, 420_000);

    it('CC-6: the credit, the scanner and the recheck of pending accounts at the same moment leave one consistent result', async () => {
      const project = await completedProject(rw.world);
      await plantAccounts(rw.world, [project.lead, project.backend]);
      await plantAccounts(rw.world, [project.frontend], { ageDays: 3 });
      clockOf(rw.world).advance(COOLING_MS + 3_600_000);
      await Promise.all([
        runCoolingEnd(rw.world, project.fx.team.id, 6),
        runCreditScan(rw.world),
        runPendingRecheck(rw.world, 3),
      ]);
      await waitCreditRun(rw.world, project.fx.team.id, 'credited');
      expect(await creditRunCount(rw.world, project.fx.team.id)).toBe(1);
      const statuses = new Map(
        (await projectCreditRows(rw.world, project.fx.team.id)).map((r) => [r.user_id, r.status]),
      );
      expect(statuses.get(project.backend.id)).toBe('credited');
      expect(statuses.get(project.frontend.id)).toBe('pending_account');
      expect(await counterValue(rw.world, project.frontend.id)).toBe(0);
      expect(await counterValue(rw.world, project.backend.id)).toBe(1);
    }, 300_000);

    it('CC-6, FR-GH-09: ten parallel rechecks of a pending member credit him once: counter +1, awards without duplicates', async () => {
      const project = await completedProject(rw.world);
      await plantAccounts(rw.world, [project.lead, project.backend]);
      await plantAccounts(rw.world, [project.frontend], { ageDays: 3 });
      await endCooling(project, { plant: false });
      await waitCreditRun(rw.world, project.fx.team.id, 'credited');
      expect(await counterValue(rw.world, project.frontend.id)).toBe(0);
      const eventsBefore = await rewardsOutbox(rw.world, 'credits_changed');
      await plantAccounts(rw.world, [project.frontend]);
      const outcomes: JobOutcome[] = await withWorkers(() => runPendingRecheck(rw.world, N));
      expect(outcomes).toHaveLength(N);
      expect(await counterValue(rw.world, project.frontend.id)).toBe(1);
      expect(await countersAgreeWithCredits(rw.world, project.frontend.id)).toBe(true);
      expect(await duplicateAwards(project.frontend.id)).toBe(0);
      expect(
        (await projectCreditRows(rw.world, project.fx.team.id)).find(
          (r) => r.user_id === project.frontend.id,
        )?.status,
      ).toBe('credited');
      expect(await rewardsOutbox(rw.world, 'credits_changed')).toBe(eventsBefore + 1);
    }, 300_000);
  },
);

describeInfra(
  'CC-6: the completion event and the scanner credit-run-scan at once -> one credit_run (S7-02)',
  ['db', 'redis', 's3'],
  () => {
    let rw: RewardsWorld;
    let deadlocksBefore = 0;

    beforeAll(async () => {
      rw = await startRewardsWorld();
      deadlocksBefore = await rw.world.deadlocks();
    }, 120_000);

    afterAll(async () => {
      if (!rw) return;
      await expectNoDeadlocks(rw.world, deadlocksBefore);
      await rw.close();
    });

    const TEN_MINUTES_AND_ONE = 11 * 60_000;

    it('CC-6: "Завершить" while five scans run at once -> one credit_run, status cooling, one timer', async () => {
      const project = await buildProject(rw.world);
      await runCheck(rw.world, project.fx.lead, project.fx.team.id);
      clockOf(rw.world).advance(TEN_MINUTES_AND_ONE);
      const [response] = await Promise.all([
        complete(rw.world, project.fx.lead, project.fx.team.id),
        runScans(5),
      ]);
      expect(response.statusCode, response.body).toBe(201);
      await waitFor(
        async () => (await creditRunStatus(rw.world, project.fx.team.id)) !== undefined,
        30_000,
      );
      await runScans(3);
      expect(await creditRunCount(rw.world, project.fx.team.id)).toBe(1);
      expect(await creditRunStatus(rw.world, project.fx.team.id)).toBe('cooling');
    }, 300_000);

    it('CC-6: the completion event is lost: five parallel scans (the completion is older than 10 minutes) create exactly one credit_run with the dates of the completion', async () => {
      const project = await completedProject(rw.world);
      const completedAt = (await creditRunRow(rw.world, project.fx.team.id))?.completed_at;
      await rw.world.sql`DELETE FROM rewards.credit_run WHERE team_id = ${project.fx.team.id}`;
      clockOf(rw.world).advance(TEN_MINUTES_AND_ONE);
      await runScans(5);
      expect(await creditRunCount(rw.world, project.fx.team.id)).toBe(1);
      const run = await creditRunRow(rw.world, project.fx.team.id);
      expect(run?.status).toBe('cooling');
      expect(run?.completed_at.getTime()).toBe(completedAt?.getTime());
      expect((run?.cooling_until.getTime() ?? 0) - (run?.completed_at.getTime() ?? 0)).toBe(
        COOLING_MS,
      );
    }, 300_000);

    async function runScans(count: number): Promise<void> {
      const outcomes = await Promise.all(
        Array.from({ length: count }, () => runCreditScan(rw.world)),
      );
      expect(outcomes.flat().every((o) => o.state === 'completed')).toBe(true);
    }
  },
);
