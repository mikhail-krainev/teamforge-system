import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { expectProblem } from '../../../../test/fixtures/assertions.js';
import {
  awardsOk,
  completedProject,
  countersOk,
  creditOk,
  decide,
  dispute,
  DISPUTE_TEXT,
  endCooling,
  fraudCase,
  openCaseOf,
  plantHistory,
  waitCreditRun,
  type FraudCaseDto,
  type Project,
} from '../../../../test/fixtures/rewards.js';
import {
  auditRows,
  awardRows,
  counterValue,
  countersAgreeWithCredits,
  creditRows,
  creditRunRow,
  disputeCount,
  fraudCaseRows,
  projectCreditRows,
} from '../../../../test/fixtures/rewards-db.js';
import { expectOk } from '../../../../test/fixtures/teams.js';
import { clockOf } from '../../../../test/fixtures/workspace.js';
import { describeInfra } from '../../../../test/helpers/infra.js';
import { startRewardsWorld, type RewardsWorld } from './support.js';

/*
 * S7-05 (written before the implementation), the gaps next to fraud.test.ts: the journal of a violation (AF-25),
 * the dispute of a frozen project and of a revoked one, a decision "ok" on a credited project (no second credit),
 * the revoked state as a participant sees it (FR-REW-12). Assumptions of fraud.test.ts apply: the audit row is found
 * by actor and reason; a case on a credited project is planted with SQL because no door opens one.
 */

const COMMENT = (label: string): string => `Решение по делу ${label}: журнал просмотрен.`;

describeInfra(
  'S7 rewards: administrator decisions and disputes, the gaps (FR-REW-11, FR-REW-12, FR-REW-16, AF-25)',
  ['db', 'redis', 's3'],
  () => {
    let rw: RewardsWorld;

    beforeAll(async () => {
      rw = await startRewardsWorld();
    });

    afterAll(async () => {
      if (rw) await rw.close();
    });

    async function plantOpenCase(project: Project): Promise<string> {
      const caseId = randomUUID();
      await rw.world.sql`
      INSERT INTO rewards.fraud_case (id, team_id, status, opened_at)
      VALUES (${caseId}, ${project.fx.team.id}, 'open', ${clockOf(rw.world).now()})`;
      return caseId;
    }

    async function creditedProject(history = 0): Promise<Project> {
      const project = await completedProject(rw.world);
      if (history > 0) {
        const earlier = Array.from({ length: history }, (_, i) => ({
          roles: ['backend'],
          completedDaysAgo: 200 + i * 30,
        }));
        await plantHistory(rw.world, project.backend, earlier);
      }
      await endCooling(project);
      await waitCreditRun(rw.world, project.fx.team.id, 'credited');
      return project;
    }

    describe('a frozen project: dispute and journal (FR-REW-11, AF-25)', () => {
      let flagged: Project;
      let caseId: string;

      beforeAll(async () => {
        flagged = await completedProject(rw.world, { prLines: 20 });
        caseId = (await openCaseOf(rw.world, rw.admin, flagged.fx.team.id)).id;
      }, 300_000);

      it('FR-REW-11: the lead, who has no credit of his own, can dispute a project frozen by AF-05: the dispute joins the open case', async () => {
        const response = await dispute(rw.world, flagged.lead, flagged.fx.team.id, DISPUTE_TEXT);
        expect(response.statusCode, response.body).toBe(201);
        expect(await fraudCaseRows(rw.world, flagged.fx.team.id)).toEqual([
          expect.objectContaining({ id: caseId, status: 'open' }),
        ]);
        const item = expectOk<FraudCaseDto>(
          'getFraudCase',
          await fraudCase(rw.world, rw.admin, caseId),
          200,
        );
        expect(item.disputes).toHaveLength(1);
      });

      it('FR-REW-12, AF-25: "violation" is in the journal once: the administrator, the comment, the time; the case keeps who decided', async () => {
        const comment = COMMENT('violation-journal');
        expectOk(
          'decideFraudCase',
          await decide(rw.world, rw.admin, caseId, 'violation', undefined, comment),
          200,
        );
        const rows = (await auditRows(rw.world, caseId)).concat(
          await auditRows(rw.world, flagged.fx.team.id),
        );
        const mine = rows.filter((r) => r.reason === comment);
        expect(mine).toHaveLength(1);
        expect(mine[0]?.actor_user_id).toBe(rw.admin.id);
        expect(JSON.stringify(mine[0]).toLowerCase()).toContain('violation');
        const stored = (await fraudCaseRows(rw.world, flagged.fx.team.id))[0];
        expect(stored).toMatchObject({ status: 'violation', decided_by: rw.admin.id, comment });
      });

      it('FR-REW-11: a dispute after the violation is refused: 409 INVALID_STATE, no second dispute is stored', async () => {
        const before = await disputeCount(rw.world, flagged.fx.team.id);
        expectProblem(
          'createDispute',
          await dispute(rw.world, flagged.backend, flagged.fx.team.id),
          409,
          'INVALID_STATE',
        );
        expect(await disputeCount(rw.world, flagged.fx.team.id)).toBe(before);
      });

      it('FR-REW-12: after the violation every participant reads "revoked", a person with a denied or revoked credit sees no rule', async () => {
        for (const member of [flagged.lead, flagged.backend, flagged.frontend]) {
          const status = await creditOk(rw.world, member, flagged.fx.team.id);
          expect(status.status).toBe('revoked');
          expect(status.myCredits.every((c) => c.status !== 'credited')).toBe(true);
        }
      });
    });

    describe('a violation on a credited project takes back only what the project gave (FR-REW-12, FR-REW-04)', () => {
      let credited: Project;
      let caseId: string;

      beforeAll(async () => {
        credited = await creditedProject(2);
        caseId = await plantOpenCase(credited);
      }, 420_000);

      it('FR-REW-12: the third project of the backend developer: 3 -> 2, the awards of this project are revoked, the earlier counters stay', async () => {
        expect(await counterValue(rw.world, credited.backend.id)).toBe(3);
        const comment = COMMENT('violation-credited');
        expectOk(
          'decideFraudCase',
          await decide(rw.world, rw.admin, caseId, 'violation', undefined, comment),
          200,
        );
        expect(await counterValue(rw.world, credited.backend.id)).toBe(2);
        expect(await counterValue(rw.world, credited.backend.id, 'backend')).toBe(2);
        expect(await countersAgreeWithCredits(rw.world, credited.backend.id)).toBe(true);
        const mine = (await awardRows(rw.world, credited.backend.id)).filter(
          (a) => a.team_id === credited.fx.team.id,
        );
        expect(mine.length).toBeGreaterThan(0);
        expect(mine.every((a) => a.revoked_at !== null)).toBe(true);
      });

      it('FR-REW-12: the participants read "revoked" with every role of their credit revoked; the public counters are lower at once', async () => {
        const mine = await creditOk(rw.world, credited.backend, credited.fx.team.id);
        expect(mine.status).toBe('revoked');
        expect(mine.myCredits.map((c) => c.status)).toEqual(['revoked']);
        expect((await countersOk(rw.world, credited.lead, credited.backend.id)).total).toBe(2);
        expect(
          (await creditRows(rw.world, credited.fx.team.id)).every((c) => c.status !== 'credited'),
        ).toBe(true);
        expect(
          (await projectCreditRows(rw.world, credited.fx.team.id)).every(
            (c) => c.status !== 'credited',
          ),
        ).toBe(true);
      });

      it('FR-REW-12: the badges of the earlier projects are not touched: only awards with the team of this project are revoked', async () => {
        const others = (await awardRows(rw.world, credited.backend.id)).filter(
          (a) => a.team_id !== credited.fx.team.id,
        );
        expect(others.every((a) => a.revoked_at === null)).toBe(true);
        const shown = await awardsOk(rw.world, credited.lead, credited.backend.id);
        expect(shown.length).toBe(others.filter((a) => a.revoked_at === null).length);
      });
    });

    describe('a decision "ok" on a project that is already credited (FR-REW-06, FR-REW-16)', () => {
      it('FR-REW-06: the case closes with "ok", nothing is credited a second time: counters, credit rows and awards are as they were', async () => {
        const credited = await creditedProject();
        const caseId = await plantOpenCase(credited);
        const countersBefore = await counterValue(rw.world, credited.backend.id);
        const awardsBefore = (await awardRows(rw.world, credited.backend.id)).length;
        const creditsBefore = (await creditRows(rw.world, credited.fx.team.id)).length;
        expectOk(
          'decideFraudCase',
          await decide(rw.world, rw.admin, caseId, 'ok', undefined, COMMENT('ok-credited')),
          200,
        );
        expect((await fraudCaseRows(rw.world, credited.fx.team.id))[0]?.status).toBe('ok');
        expect((await creditRunRow(rw.world, credited.fx.team.id))?.status).toBe('credited');
        expect(await counterValue(rw.world, credited.backend.id)).toBe(countersBefore);
        expect((await awardRows(rw.world, credited.backend.id)).length).toBe(awardsBefore);
        expect((await creditRows(rw.world, credited.fx.team.id)).length).toBe(creditsBefore);
      }, 420_000);
    });
  },
);
