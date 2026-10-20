import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { expectProblem, expectReplayed } from '../../../../test/fixtures/assertions.js';
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
  fraudCases,
  membersOf,
  openCaseOf,
  plantAccounts,
  plantHistory,
  runCoolingEnd,
  waitCreditRun,
  COOLING_MS,
  type FraudCaseDto,
  type FraudCasePageDto,
  type Project,
  type DisputeDto,
} from '../../../../test/fixtures/rewards.js';
import {
  auditRows,
  counterValue,
  countersAgreeWithCredits,
  creditRows,
  creditRunRow,
  disputeCount,
  fraudCaseRows,
  fraudSignalRows,
  projectCreditRows,
  rewardsOutbox,
  awardRows,
} from '../../../../test/fixtures/rewards-db.js';
import { expectOk } from '../../../../test/fixtures/teams.js';
import { clockOf } from '../../../../test/fixtures/workspace.js';
import { describeInfra } from '../../../../test/helpers/infra.js';
import { expectNoFraudDetails, startRewardsWorld, type RewardsWorld } from './support.js';

/*
 * S7-03 and S7-05 (written before the implementation): the anti-fraud freeze, the queue of manual review, the
 * decisions and the disputes (FR-REW-11, FR-REW-12, FR-REW-15, FR-REW-16, AF-05, AF-24, AF-25; architecture 10.1,
 * 10.4). The rules themselves are unit-tested in internal/fraud/rules/AF-xx.test.ts. A project is frozen here with
 * the rule AF-05 (the merged pull requests change fewer than 200 lines: `prLines: 20`); a clean project is not.
 *
 * ASSUMPTIONS (the contract leaves them open):
 *   - one open fraud_case per team (unique partial index): a dispute of a second member joins the open case; the same
 *     member disputes a project once (409 INVALID_STATE for the repeat);
 *   - a decision `ok` on a project that is still cooling credits at once ("ok запускает выдачу"); on a frozen project
 *     whose cooling is over too;
 *   - a decision `violation` on a project that was never credited revokes nothing but marks credit_run `revoked`;
 *   - the audit row (`admin_audit`) of a decision has the administrator as actor and the comment as the reason; the
 *     action and target names are the implementation's, so rows are found by actor and reason.
 */

const COMMENT = (label: string): string => `Решение по делу ${label}: проверено вручную.`;

describeInfra('S7 rewards: anti-fraud, manual review, disputes (FR-REW-11, FR-REW-12, FR-REW-15, FR-REW-16, AF-24, AF-25)', ['db', 'redis', 's3'], () => {
  let rw: RewardsWorld;

  beforeAll(async () => {
    rw = await startRewardsWorld();
  });

  afterAll(async () => {
    if (rw) await rw.close();
  });

  const adminCases = async (query: Record<string, string | number> = {}): Promise<FraudCasePageDto> =>
    expectOk<FraudCasePageDto>('listFraudCases', await fraudCases(rw.world, rw.admin, query), 200);

  describe('a clean project is not frozen (FR-REW-15)', () => {
    it('FR-REW-15: no flag and a sum of signals below C-61 -> credit_run cooling, no fraud case, no blocking or flagging signal', async () => {
      const clean = await completedProject(rw.world);
      expect((await creditRunRow(rw.world, clean.fx.team.id))?.status).toBe('cooling');
      expect(await fraudCaseRows(rw.world, clean.fx.team.id)).toEqual([]);
      const signals = await fraudSignalRows(rw.world, clean.fx.team.id);
      expect(signals.filter((s) => s.action === 'flag' || s.action === 'block')).toEqual([]);
      expect(signals.reduce((sum, s) => sum + s.score, 0)).toBeLessThan(3);
    }, 240_000);
  });

  describe('a flag freezes the project (FR-REW-15, FR-REW-16, AF-05, AF-24)', () => {
    let flagged: Project;
    let flaggedCase: FraudCaseDto;

    beforeAll(async () => {
      flagged = await completedProject(rw.world, { prLines: 20 });
      flaggedCase = await openCaseOf(rw.world, rw.admin, flagged.fx.team.id);
    }, 300_000);

    it('FR-REW-15: the flag AF-05 freezes the credit_run right after the completion; one open case; the signal is stored with its phase', async () => {
      expect((await creditRunRow(rw.world, flagged.fx.team.id))?.status).toBe('frozen');
      expect(await fraudCaseRows(rw.world, flagged.fx.team.id)).toEqual([expect.objectContaining({ status: 'open' })]);
      const signal = (await fraudSignalRows(rw.world, flagged.fx.team.id)).find((s) => s.rule_code === 'AF-05');
      expect(signal).toMatchObject({ phase: 'completion', action: 'flag' });
      expect(await rewardsOutbox(rw.world, 'case_opened')).toBeGreaterThanOrEqual(1);
    });

    it('FR-REW-16: the administrator sees the project, the rules that fired and the disputes; no personal data beyond what is needed', async () => {
      const item = flaggedCase;
      expect(item).toMatchObject({ teamId: flagged.fx.team.id, teamName: flagged.fx.team.dto.name, status: 'open' });
      expect(item.signals).toEqual(expect.arrayContaining([expect.objectContaining({ ruleCode: 'AF-05', action: 'flag' })]));
      const text = JSON.stringify(item);
      for (const user of [flagged.lead, flagged.backend, flagged.frontend]) {
        expect(text).not.toContain(user.email);
        expect(text).not.toContain(user.id);
      }
      const single = expectOk<FraudCaseDto>('getFraudCase', await fraudCase(rw.world, rw.admin, flaggedCase.id), 200);
      expect(single).toEqual(flaggedCase);
    });

    it('FR-REW-15: a participant sees "frozen" and none of the rules, scores or signals', async () => {
      for (const member of [flagged.lead, flagged.backend, flagged.frontend]) {
        const response = await rw.world.as(member).get(`/v1/teams/${flagged.fx.team.id}/credit`);
        expect(response.statusCode).toBe(200);
        expect(response.json<{ status: string }>().status).toBe('frozen');
        expectNoFraudDetails(response);
      }
    });

    it('AF-24: the end of the cooling does not credit a frozen project: still frozen, no rows, zero counters', async () => {
      await endCooling(flagged);
      expect((await creditRunRow(rw.world, flagged.fx.team.id))?.status).toBe('frozen');
      expect(await projectCreditRows(rw.world, flagged.fx.team.id)).toEqual([]);
      expect((await countersOk(rw.world, flagged.lead, flagged.backend.id)).total).toBe(0);
    }, 120_000);
  });

  describe('decision "ok" (FR-REW-16, FR-REW-06, AF-25)', () => {
    let flagged: Project;
    let caseId: string;
    const comment = COMMENT('ok');

    beforeAll(async () => {
      flagged = await completedProject(rw.world, { prLines: 20 });
      caseId = (await openCaseOf(rw.world, rw.admin, flagged.fx.team.id)).id;
    }, 300_000);

    it('FR-REW-16: "ok" -> 200, the case is decided with the time and the comment; the project is credited at once', async () => {
      await plantAccounts(rw.world, membersOf(flagged));
      const response = await decide(rw.world, rw.admin, caseId, 'ok', undefined, comment);
      const body = expectOk<FraudCaseDto>('decideFraudCase', response, 200);
      expect(body).toMatchObject({ id: caseId, status: 'ok', comment });
      expect(Number.isNaN(Date.parse(body.decidedAt ?? ''))).toBe(false);
      await waitCreditRun(rw.world, flagged.fx.team.id, 'credited');
      expect((await countersOk(rw.world, flagged.lead, flagged.backend.id)).total).toBe(1);
      expect((await creditOk(rw.world, flagged.backend, flagged.fx.team.id)).status).toBe('credited');
      expect((await awardsOk(rw.world, flagged.lead, flagged.backend.id)).length).toBeGreaterThan(0);
    });

    it('AF-25: the decision is in the audit log: who (the administrator), why (the comment), when', async () => {
      const rows = (await auditRows(rw.world, caseId)).concat(await auditRows(rw.world, flagged.fx.team.id));
      const mine = rows.filter((r) => r.actor_user_id === rw.admin.id && r.reason === comment);
      expect(mine).toHaveLength(1);
      expect(Number.isNaN(mine[0]?.at.getTime() ?? Number.NaN)).toBe(false);
    });

    it('FR-REW-12: a second decision on the same case -> 409 INVALID_STATE, nothing changes', async () => {
      const countersBefore = await counterValue(rw.world, flagged.backend.id);
      expectProblem('decideFraudCase', await decide(rw.world, rw.admin, caseId, 'violation'), 409, 'INVALID_STATE');
      expectProblem('decideFraudCase', await decide(rw.world, rw.admin, caseId, 'ok'), 409, 'INVALID_STATE');
      expect((await creditRunRow(rw.world, flagged.fx.team.id))?.status).toBe('credited');
      expect(await counterValue(rw.world, flagged.backend.id)).toBe(countersBefore);
      expect((await fraudCaseRows(rw.world, flagged.fx.team.id))[0]?.status).toBe('ok');
    });

    it('FR-REW-04: the counters of the person agree with his credits after the decision', async () => {
      expect(await countersAgreeWithCredits(rw.world, flagged.backend.id)).toBe(true);
    });
  });

  describe('decision "violation" on a project that was never credited (FR-REW-12)', () => {
    let flagged: Project;
    let caseId: string;
    const key = randomUUID();

    beforeAll(async () => {
      flagged = await completedProject(rw.world, { prLines: 20 });
      caseId = (await openCaseOf(rw.world, rw.admin, flagged.fx.team.id)).id;
      await endCooling(flagged);
    }, 300_000);

    it('FR-REW-12: "violation" -> 200, credit_run revoked, nobody credited, no counters, no awards', async () => {
      const comment = COMMENT('violation-1');
      const response = await decide(rw.world, rw.admin, caseId, 'violation', key, comment);
      expect(expectOk<FraudCaseDto>('decideFraudCase', response, 200)).toMatchObject({ status: 'violation', comment });
      expect((await creditRunRow(rw.world, flagged.fx.team.id))?.status).toBe('revoked');
      expect((await projectCreditRows(rw.world, flagged.fx.team.id)).filter((r) => r.status === 'credited')).toEqual([]);
      expect((await countersOk(rw.world, flagged.lead, flagged.backend.id)).total).toBe(0);
      expect(await awardsOk(rw.world, flagged.lead, flagged.backend.id)).toEqual([]);
      expect((await creditOk(rw.world, flagged.backend, flagged.fx.team.id)).status).toBe('revoked');
    });

    it('FR-REW-12 (paired): the same key repeated -> the stored 200 with Idempotent-Replayed, no second audit row', async () => {
      const comment = COMMENT('violation-1');
      const replay = await decide(rw.world, rw.admin, caseId, 'violation', key, comment);
      expect(replay.statusCode).toBe(200);
      expectReplayed(replay);
      const rows = (await auditRows(rw.world, caseId)).concat(await auditRows(rw.world, flagged.fx.team.id));
      expect(rows.filter((r) => r.reason === comment)).toHaveLength(1);
    });

    it('FR-REW-12: another key after the decision -> 409 INVALID_STATE', async () => {
      expectProblem('decideFraudCase', await decide(rw.world, rw.admin, caseId, 'violation'), 409, 'INVALID_STATE');
    });
  });

  describe('decision "violation" on a credited project: the counters go down by what was credited (FR-REW-12, CC-12)', () => {
    let credited: Project;
    let caseId: string;

    beforeAll(async () => {
      credited = await completedProject(rw.world);
      // an earlier project of the backend developer: the counters must go from 2 to 1, not to 0
      await plantHistory(rw.world, credited.backend, [{ roles: ['backend'], completedDaysAgo: 200 }]);
      await endCooling(credited);
      await waitCreditRun(rw.world, credited.fx.team.id, 'credited');
      // a case on a credited project (discovered after the credit); the table is planted, there is no door that opens one
      caseId = randomUUID();
      await rw.world.sql`
        INSERT INTO rewards.fraud_case (id, team_id, status, opened_at)
        VALUES (${caseId}, ${credited.fx.team.id}, 'open', ${clockOf(rw.world).now()})`;
    }, 360_000);

    it('FR-REW-12: credit and project_credit become revoked, the counters drop by one, the awards of the project are revoked', async () => {
      const awardsBefore = (await awardsOk(rw.world, credited.lead, credited.backend.id)).length;
      expect(awardsBefore).toBeGreaterThan(0);
      expect((await countersOk(rw.world, credited.lead, credited.backend.id)).total).toBe(2);
      const response = await decide(rw.world, rw.admin, caseId, 'violation', undefined, COMMENT('violation-2'));
      expect(expectOk<FraudCaseDto>('decideFraudCase', response, 200).status).toBe('violation');

      expect((await creditRunRow(rw.world, credited.fx.team.id))?.status).toBe('revoked');
      expect((await projectCreditRows(rw.world, credited.fx.team.id)).every((r) => r.status !== 'credited')).toBe(true);
      expect((await creditRows(rw.world, credited.fx.team.id)).every((r) => r.status !== 'credited')).toBe(true);
      const counters = await countersOk(rw.world, credited.lead, credited.backend.id);
      expect(counters.total).toBe(1);
      expect(counters.byRole).toEqual([{ roleCode: 'backend', value: 1 }]);
      expect((await countersOk(rw.world, credited.lead, credited.frontend.id)).total).toBe(0);
      expect(await countersAgreeWithCredits(rw.world, credited.backend.id)).toBe(true);

      const revoked = (await awardRows(rw.world, credited.backend.id)).filter((a) => a.team_id === credited.fx.team.id);
      expect(revoked.length).toBeGreaterThan(0);
      expect(revoked.every((a) => a.revoked_at !== null && Boolean(a.revoke_reason))).toBe(true);
      expect(await awardsOk(rw.world, credited.lead, credited.frontend.id)).toEqual([]);
      expect(await rewardsOutbox(rw.world, 'award_revoked')).toBeGreaterThanOrEqual(1);
    });

    it('FR-REW-12: matching sees the lower completed count of the role', async () => {
      const rows = await rw.world.sql<{ completed_count: number }[]>`
        SELECT completed_count FROM matching.candidate_stats WHERE user_id = ${credited.backend.id} AND role_code = 'backend'`;
      expect(rows[0]?.completed_count ?? 0).toBe(1);
      const frontend = await rw.world.sql<{ completed_count: number }[]>`
        SELECT completed_count FROM matching.candidate_stats WHERE user_id = ${credited.frontend.id} AND role_code = 'frontend'`;
      expect(frontend[0]?.completed_count ?? 0).toBe(0);
    });

    it('FR-REW-12: a repeated run of the cooling timer on a revoked project credits nothing again', async () => {
      await runCoolingEnd(rw.world, credited.fx.team.id);
      expect((await creditRunRow(rw.world, credited.fx.team.id))?.status).toBe('revoked');
      expect((await countersOk(rw.world, credited.lead, credited.backend.id)).total).toBe(1);
    });
  });

  describe('a dispute in the cooling (FR-REW-11, FR-REW-16)', () => {
    let project: Project;
    let first: DisputeDto;

    beforeAll(async () => {
      project = await completedProject(rw.world);
    }, 240_000);

    const teamId = (): string => project.fx.team.id;

    it('FR-REW-11: a participant disputes in the cooling: 201, the credit freezes, one open case is opened', async () => {
      const response = await dispute(rw.world, project.frontend, teamId(), DISPUTE_TEXT);
      first = expectOk<DisputeDto>('createDispute', response, 201);
      expect(first.teamId).toBe(teamId());
      expect(Number.isNaN(Date.parse(first.createdAt))).toBe(false);
      expect((await creditRunRow(rw.world, teamId()))?.status).toBe('frozen');
      expect(await fraudCaseRows(rw.world, teamId())).toEqual([expect.objectContaining({ status: 'open' })]);
      expect(await disputeCount(rw.world, teamId())).toBe(1);
      expect((await creditOk(rw.world, project.backend, teamId())).status).toBe('frozen');
    });

    it('FR-REW-11 (paired): the same key repeated -> the stored 201 with Idempotent-Replayed, still one dispute', async () => {
      const key = randomUUID();
      const other = await dispute(rw.world, project.backend, teamId(), `${DISPUTE_TEXT} (второй участник)`, key);
      expect(other.statusCode, other.body).toBe(201);
      const replay = await dispute(rw.world, project.backend, teamId(), `${DISPUTE_TEXT} (второй участник)`, key);
      expect(replay.statusCode).toBe(201);
      expectReplayed(replay);
      expect(replay.json()).toEqual(other.json());
      expect(await disputeCount(rw.world, teamId())).toBe(2);
    });

    it('FR-REW-11: a second member joins the same open case (one open case per team)', async () => {
      expect(await fraudCaseRows(rw.world, teamId())).toHaveLength(1);
      const item = await openCaseOf(rw.world, rw.admin, teamId());
      expect(item.disputes).toHaveLength(2);
      expect(item.disputes?.map((d) => d.text)).toEqual(expect.arrayContaining([DISPUTE_TEXT]));
      expect(JSON.stringify(item.disputes)).not.toContain(project.frontend.id);
    });

    it('FR-REW-11: the same member disputes the project once: the repeat with another key -> 409 INVALID_STATE', async () => {
      expectProblem('createDispute', await dispute(rw.world, project.frontend, teamId(), DISPUTE_TEXT), 409, 'INVALID_STATE');
      expect(await disputeCount(rw.world, teamId())).toBe(2);
    });

    it('FR-REW-11: a text of fewer than 20 characters or an unknown field -> 400 VALIDATION_FAILED', async () => {
      expectProblem('createDispute', await dispute(rw.world, project.lead, teamId(), 'мало'), 400, 'VALIDATION_FAILED');
      const extra = await rw.world.as(project.lead).post(`/v1/teams/${teamId()}/disputes`, { text: DISPUTE_TEXT, userId: project.backend.id });
      expectProblem('createDispute', extra, 400, 'VALIDATION_FAILED');
      expect(await disputeCount(rw.world, teamId())).toBe(2);
    });

    it('FR-REW-11: the case of a dispute can be closed with "ok": the project is credited', async () => {
      const item = await openCaseOf(rw.world, rw.admin, teamId());
      await plantAccounts(rw.world, membersOf(project));
      expectOk('decideFraudCase', await decide(rw.world, rw.admin, item.id, 'ok', undefined, COMMENT('dispute-ok')), 200);
      await waitCreditRun(rw.world, teamId(), 'credited');
      expect((await countersOk(rw.world, project.lead, project.backend.id)).total).toBe(1);
    });

    it('FR-REW-11: after the project is credited a dispute is refused: 409 INVALID_STATE', async () => {
      expectProblem('createDispute', await dispute(rw.world, project.lead, teamId()), 409, 'INVALID_STATE');
    });
  });

  describe('the cooling is over (FR-REW-11)', () => {
    it('FR-REW-11: after cooling_until a dispute is refused with 409 INVALID_STATE even if the timer has not run; nothing is frozen', async () => {
      const late = await completedProject(rw.world);
      clockOf(rw.world).advance(COOLING_MS + 3_600_000);
      expectProblem('createDispute', await dispute(rw.world, late.frontend, late.fx.team.id), 409, 'INVALID_STATE');
      expect(await fraudCaseRows(rw.world, late.fx.team.id)).toEqual([]);
      expect(await disputeCount(rw.world, late.fx.team.id)).toBe(0);
      expect((await creditRunRow(rw.world, late.fx.team.id))?.status).toBe('cooling');
    }, 240_000);
  });

  describe('the queue of manual review (FR-REW-16)', () => {
    it('FR-REW-16: the status filter returns only cases of that status, newest queue first per the contract; every item has the contract fields', async () => {
      const all = await adminCases({ limit: 100 });
      expect(all.items.length).toBeGreaterThanOrEqual(4);
      for (const status of ['open', 'ok', 'violation'] as const) {
        const page = await adminCases({ status, limit: 100 });
        expect(page.items.every((c) => c.status === status), status).toBe(true);
        expect(page.items.length, status).toBeGreaterThan(0);
      }
      const decided = (await adminCases({ status: 'ok', limit: 100 })).items;
      expect(decided.every((c) => Boolean(c.decidedAt) && Boolean(c.comment))).toBe(true);
    });

    it('FR-REW-16: the cursor walks the queue page by page without repeats', async () => {
      const seen = new Set<string>();
      let cursor: string | null = null;
      for (let i = 0; i < 20; i += 1) {
        const page: FraudCasePageDto = await adminCases({ limit: 1, ...(cursor ? { cursor } : {}) });
        expect(page.items.length).toBeLessThanOrEqual(1);
        for (const item of page.items) {
          expect(seen.has(item.id)).toBe(false);
          seen.add(item.id);
        }
        cursor = page.nextCursor;
        if (!cursor) break;
      }
      expect(seen.size).toBeGreaterThanOrEqual(4);
      expect(cursor).toBeNull();
    });

    it('FR-REW-16: an unknown status or a limit above 100 -> 400 VALIDATION_FAILED; an unknown case -> 404', async () => {
      expectProblem('listFraudCases', await fraudCases(rw.world, rw.admin, { status: 'bogus' }), 400, 'VALIDATION_FAILED');
      expectProblem('listFraudCases', await fraudCases(rw.world, rw.admin, { limit: 101 }), 400, 'VALIDATION_FAILED');
      expectProblem('getFraudCase', await fraudCase(rw.world, rw.admin, '00000000-0000-4000-8000-000000000999'), 404, 'NOT_FOUND');
    });

    it('FR-REW-16: a decision needs a comment of 10..4000 characters and a known decision; an unknown field is refused', async () => {
      const [decided] = (await adminCases({ status: 'ok', limit: 1 })).items;
      const caseId = decided?.id ?? '00000000-0000-4000-8000-000000000999';
      const post = (body: unknown) => rw.world.as(rw.admin).post(`/v1/admin/fraud-cases/${caseId}/decision`, body);
      expectProblem('decideFraudCase', await post({ decision: 'ok', comment: 'коротко' }), 400, 'VALIDATION_FAILED');
      expectProblem('decideFraudCase', await post({ decision: 'maybe', comment: COMMENT('x') }), 400, 'VALIDATION_FAILED');
      expectProblem('decideFraudCase', await post({ decision: 'ok', comment: COMMENT('x'), notify: true }), 400, 'VALIDATION_FAILED');
    });
  });
});
