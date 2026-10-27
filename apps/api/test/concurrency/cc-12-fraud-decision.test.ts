import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { codesAt, expectReplayOf, fireAll, tally, winnerOf } from '../fixtures/concurrency.js';
import {
  completedProject,
  decide,
  dispute,
  DISPUTE_TEXT,
  endCooling,
  membersOf,
  openCaseOf,
  plantAccounts,
  plantHistory,
  runPendingRecheck,
  waitCreditRun,
  type Project,
} from '../fixtures/rewards.js';
import {
  auditRows,
  awardRows,
  counterValue,
  countersAgreeWithCredits,
  creditRunRow,
  disputeCount,
  fraudCaseRows,
  projectCreditRows,
} from '../fixtures/rewards-db.js';
import { startRewardsWorld, type RewardsWorld } from '../fixtures/rewards-world.js';
import { expectNoDeadlocks } from '../fixtures/teams-db.js';
import { clockOf } from '../fixtures/workspace.js';
import { describeInfra } from '../helpers/infra.js';

/*
 * CC-12, the decision of an administrator and the disputes (FR-REW-11, FR-REW-12, FR-REW-16, AF-25; docs/plan.md
 * S7-05; architecture 10.4, 12.2): the revocation takes lock #11 `credit_run FOR UPDATE` and checks that the
 * `fraud_case` is still `open` under it; the counters go down by what `RETURNING` really changed. Ten decisions on
 * one case -> 1 x 200, 9 x 409 INVALID_STATE. A revocation at the same moment as `pending-account-recheck` must
 * not take the counter below its initial value nor credit a revoked project. Disputes: a person disputes once, the
 * team has one open case (`fraud_case_open_uq`). Races of the credit itself are in cc-06-credit.test.ts.
 */

const N = 10;
const COMMENT = (label: string): string => `Решение по делу ${label}: параллельная проверка.`;

describeInfra(
  'CC-12: parallel decisions and disputes (FR-REW-12, FR-REW-16)',
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

    const frozen = async (): Promise<{ project: Project; caseId: string }> => {
      const project = await completedProject(rw.world, { prLines: 20 });
      return { project, caseId: (await openCaseOf(rw.world, rw.admin, project.fx.team.id)).id };
    };

    const auditOf = async (caseId: string, project: Project): Promise<number> =>
      (await auditRows(rw.world, caseId))
        .concat(await auditRows(rw.world, project.fx.team.id))
        .filter((r) => r.actor_user_id === rw.admin.id).length;

    /** A credited project with an earlier project of the backend developer and a case planted on it. */
    async function creditedWithCase(): Promise<{ project: Project; caseId: string }> {
      const project = await completedProject(rw.world);
      await plantHistory(rw.world, project.backend, [
        { roles: ['backend'], completedDaysAgo: 200 },
      ]);
      await endCooling(project);
      await waitCreditRun(rw.world, project.fx.team.id, 'credited');
      const caseId = randomUUID();
      await rw.world.sql`
      INSERT INTO rewards.fraud_case (id, team_id, status, opened_at)
      VALUES (${caseId}, ${project.fx.team.id}, 'open', ${clockOf(rw.world).now()})`;
      return { project, caseId };
    }

    it('CC-12: 10 parallel "violation" with different keys on one case -> 1 x 200, 9 x 409 INVALID_STATE; one journal row', async () => {
      const { project, caseId } = await frozen();
      const fired = await fireAll(N, (_i, key) =>
        decide(rw.world, rw.admin, caseId, 'violation', key, COMMENT('v10')),
      );
      expect(tally(fired)).toEqual({ 200: 1, 409: N - 1 });
      expect(codesAt(fired, 409)).toEqual(['INVALID_STATE']);
      expect(await auditOf(caseId, project)).toBe(1);
      expect((await creditRunRow(rw.world, project.fx.team.id))?.status).toBe('revoked');
      expect(await fraudCaseRows(rw.world, project.fx.team.id)).toEqual([
        expect.objectContaining({ status: 'violation' }),
      ]);
    }, 300_000);

    it('CC-12: five "ok" and five "violation" at once -> exactly one wins, the others 409; the project ends in the state of the winner', async () => {
      const { project, caseId } = await frozen();
      await plantAccounts(rw.world, membersOf(project));
      const fired = await fireAll(N, (i, key) =>
        decide(rw.world, rw.admin, caseId, i % 2 === 0 ? 'ok' : 'violation', key, COMMENT('mixed')),
      );
      expect(tally(fired)).toEqual({ 200: 1, 409: N - 1 });
      const winner = winnerOf(fired, 200);
      const decision = winner.index % 2 === 0 ? 'ok' : 'violation';
      expect((await fraudCaseRows(rw.world, project.fx.team.id))[0]?.status).toBe(decision);
      expect(await auditOf(caseId, project)).toBe(1);
      const run = (await creditRunRow(rw.world, project.fx.team.id))?.status;
      if (decision === 'ok') {
        // S7SEC-01: "ok" returns the project to the cooling; its end credits it once.
        expect(run).toBe('cooling');
        expect(await counterValue(rw.world, project.backend.id)).toBe(0);
        await endCooling(project);
        expect((await creditRunRow(rw.world, project.fx.team.id))?.status).toBe('credited');
        expect(await counterValue(rw.world, project.backend.id)).toBe(1);
      } else {
        expect(run).toBe('revoked');
        expect(await counterValue(rw.world, project.backend.id)).toBe(0);
      }
      expect(await countersAgreeWithCredits(rw.world, project.backend.id)).toBe(true);
    }, 300_000);

    it('CC-12: 10 parallel "violation" on a credited project lower the counters once: 2 -> 1, the awards are revoked once, one journal row', async () => {
      const { project, caseId } = await creditedWithCase();
      expect(await counterValue(rw.world, project.backend.id)).toBe(2);
      const fired = await fireAll(N, (_i, key) =>
        decide(rw.world, rw.admin, caseId, 'violation', key, COMMENT('credited')),
      );
      expect(tally(fired)).toEqual({ 200: 1, 409: N - 1 });
      expect(await counterValue(rw.world, project.backend.id)).toBe(1);
      expect(await counterValue(rw.world, project.backend.id, 'backend')).toBe(1);
      expect(await counterValue(rw.world, project.frontend.id)).toBe(0);
      expect(await countersAgreeWithCredits(rw.world, project.backend.id)).toBe(true);
      const mine = (await awardRows(rw.world, project.backend.id)).filter(
        (a) => a.team_id === project.fx.team.id,
      );
      expect(mine.length).toBeGreaterThan(0);
      expect(mine.every((a) => a.revoked_at !== null)).toBe(true);
      expect(await auditOf(caseId, project)).toBe(1);
    }, 420_000);

    it('CC-12 (paired): the winner repeats his key -> the stored 200 with Idempotent-Replayed; a loser repeats his -> the stored 409; still one journal row', async () => {
      const { project, caseId } = await frozen();
      const comment = COMMENT('paired');
      const fired = await fireAll(5, (_i, key) =>
        decide(rw.world, rw.admin, caseId, 'violation', key, comment),
      );
      const winner = winnerOf(fired, 200);
      const loser = winnerOf(fired, 409);
      expectReplayOf(
        winner,
        await decide(rw.world, rw.admin, caseId, 'violation', winner.key, comment),
      );
      expectReplayOf(
        loser,
        await decide(rw.world, rw.admin, caseId, 'violation', loser.key, comment),
      );
      expect(await auditOf(caseId, project)).toBe(1);
    }, 300_000);

    it('CC-12: 10 decisions with one key -> every answer is the stored one (200) or a conflict, one decision is made', async () => {
      const { project, caseId } = await frozen();
      const key = randomUUID();
      const fired = await fireAll(
        N,
        (_i, k) => decide(rw.world, rw.admin, caseId, 'violation', k, COMMENT('same-key')),
        Array.from({ length: N }, () => key),
      );
      expect(fired.every((f) => f.status === 200 || f.status === 409)).toBe(true);
      expect(fired.filter((f) => f.status === 200).length).toBeGreaterThanOrEqual(1);
      expect(await auditOf(caseId, project)).toBe(1);
      expect((await creditRunRow(rw.world, project.fx.team.id))?.status).toBe('revoked');
    }, 300_000);

    it('CC-12: decisions on two different cases at once both succeed and do not deadlock', async () => {
      const first = await frozen();
      const second = await frozen();
      const [one, two] = await Promise.all([
        decide(rw.world, rw.admin, first.caseId, 'violation', undefined, COMMENT('two-a')),
        decide(rw.world, rw.admin, second.caseId, 'violation', undefined, COMMENT('two-b')),
      ]);
      expect([one.statusCode, two.statusCode]).toEqual([200, 200]);
    }, 420_000);

    it('CC-12: a revocation at the same moment as pending-account-recheck never lowers the counter below its start, never credits a revoked project', async () => {
      const project = await completedProject(rw.world);
      await plantHistory(rw.world, project.frontend, [
        { roles: ['frontend'], completedDaysAgo: 200 },
      ]);
      await plantAccounts(rw.world, [project.lead, project.backend]);
      await plantAccounts(rw.world, [project.frontend], { ageDays: 3 });
      await endCooling(project, { plant: false });
      await waitCreditRun(rw.world, project.fx.team.id, 'credited');
      expect(await counterValue(rw.world, project.frontend.id)).toBe(1);
      const caseId = randomUUID();
      await rw.world.sql`
      INSERT INTO rewards.fraud_case (id, team_id, status, opened_at)
      VALUES (${caseId}, ${project.fx.team.id}, 'open', ${clockOf(rw.world).now()})`;
      await plantAccounts(rw.world, [project.frontend]);

      const [decision] = await Promise.all([
        decide(rw.world, rw.admin, caseId, 'violation', undefined, COMMENT('recheck')),
        runPendingRecheck(rw.world, 5),
      ]);
      expect(decision.statusCode, decision.body).toBe(200);
      expect((await creditRunRow(rw.world, project.fx.team.id))?.status).toBe('revoked');
      expect(await counterValue(rw.world, project.frontend.id)).toBe(1);
      expect(await counterValue(rw.world, project.backend.id)).toBe(0);
      for (const member of membersOf(project)) {
        expect(await countersAgreeWithCredits(rw.world, member.id), member.displayName).toBe(true);
      }
      const left = await projectCreditRows(rw.world, project.fx.team.id);
      expect(left.some((r) => r.status === 'credited')).toBe(false);
    }, 420_000);

    describe('disputes of the participants', () => {
      let project: Project;

      beforeAll(async () => {
        project = await completedProject(rw.world);
      }, 240_000);

      it('CC-12: three participants dispute four times each at once -> each gets one 201 and three 409; one open case, three disputes', async () => {
        const people = [project.lead, project.backend, project.frontend];
        const fired = await fireAll(people.length * 4, (i, key) =>
          dispute(
            rw.world,
            people[i % people.length] ?? project.lead,
            project.fx.team.id,
            DISPUTE_TEXT,
            key,
          ),
        );
        expect(tally(fired)).toEqual({ 201: 3, 409: 9 });
        expect(codesAt(fired, 409)).toEqual(['INVALID_STATE']);
        for (let person = 0; person < people.length; person += 1) {
          const mine = fired.filter((f) => f.index % people.length === person);
          expect(mine.filter((f) => f.status === 201)).toHaveLength(1);
        }
        expect(await disputeCount(rw.world, project.fx.team.id)).toBe(3);
        const cases = await fraudCaseRows(rw.world, project.fx.team.id);
        expect(cases.filter((c) => c.status === 'open')).toHaveLength(1);
        expect((await creditRunRow(rw.world, project.fx.team.id))?.status).toBe('frozen');
      }, 120_000);

      it('CC-12 (paired): the winner of the burst repeats his key -> the stored 201 with Idempotent-Replayed; still one dispute', async () => {
        const second = await completedProject(rw.world);
        const fired = await fireAll(5, (_i, key) =>
          dispute(rw.world, second.backend, second.fx.team.id, DISPUTE_TEXT, key),
        );
        expect(tally(fired)).toEqual({ 201: 1, 409: 4 });
        const winner = winnerOf(fired, 201);
        expectReplayOf(
          winner,
          await dispute(rw.world, second.backend, second.fx.team.id, DISPUTE_TEXT, winner.key),
        );
        expect(await disputeCount(rw.world, second.fx.team.id)).toBe(1);
      }, 300_000);

      it('CC-12: a dispute at the same moment as the decision "ok" of the case it joined: the result is consistent', async () => {
        const { project: p, caseId } = await frozen();
        await plantAccounts(rw.world, membersOf(p));
        const [filed, decided] = await Promise.all([
          dispute(rw.world, p.frontend, p.fx.team.id, DISPUTE_TEXT),
          decide(rw.world, rw.admin, caseId, 'ok', undefined, COMMENT('dispute-race')),
        ]);
        expect(decided.statusCode, decided.body).toBe(200);
        // S7SEC-01: "ok" returns the project to the cooling, which can be disputed: the dispute either joined the
        // case before the decision or comes after it and freezes the project again with a case of its own.
        expect(filed.statusCode, filed.body).toBe(201);
        expect(await disputeCount(rw.world, p.fx.team.id)).toBe(1);
        const cases = await fraudCaseRows(rw.world, p.fx.team.id);
        const open = cases.filter((c) => c.status === 'open');
        const status = (await creditRunRow(rw.world, p.fx.team.id))?.status;
        expect(open).toHaveLength(status === 'frozen' ? 1 : 0);
        expect(status === 'frozen' ? cases.length === 2 : status === 'cooling').toBe(true);
      }, 300_000);
    });
  },
);
