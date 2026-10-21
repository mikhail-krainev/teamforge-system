import { expect } from '@playwright/test';
import { expectNoSeriousA11yViolations } from './axe';
import { post } from './slice6-world';
import { awardsUi, BADGES, creditUi, fraudUi, ROUTES } from './slice7-ui';
import {
  awardNames,
  countersOf,
  get,
  person,
  sqlValue,
  waitForCreditStatus,
  world,
  type CountersBody,
  type Person,
} from './slice7-world';

/**
 * Steps 5 and 6 of slice7.spec.ts (FR-REW-12, FR-REW-15, FR-REW-16, FR-REW-11, AF-05, AF-25, CC-12): the
 * second project (support/slice7-project-steps.ts, tiny pull requests) goes `frozen` at the completion, a
 * participant files a complaint in the cooling window, the administrator opens the case in `/admin/fraud`
 * and decides `violation` with a confirmation. Written before S7-05, S7-08 and S7-10: it must fail until
 * they are done.
 *
 * What the plan calls "значки и счётчики участников уменьшаются" (step 5): a project that was frozen at
 * the completion was never credited, so the decision `violation` revokes it (`credit_run.status =
 * 'revoked'`) and leaves the totals of the participants where the first project put them (counter 1, the
 * badge "Первый релиз"); nothing of the second project is ever granted. A real decrease needs a credited
 * project with an open case, which the contract does not offer (the complaint is allowed only in the
 * cooling); see the report of S7-01.
 */

const DECISION_PATH = (caseId: string): string => `/v1/admin/fraud-cases/${caseId}/decision`;

interface CaseBody {
  id: string;
  teamId: string;
  teamName: string;
  status: 'open' | 'ok' | 'violation';
  signals: { ruleCode: string; score: number; action: string }[];
  disputes?: { text: string; createdAt: string }[];
  comment?: string | null;
}

interface CasePage {
  items: CaseBody[];
  nextCursor: string | null;
}

interface Snapshot {
  counters: CountersBody;
  awards: string[];
}

/** The totals the participants had while the second project was frozen. */
const before = new Map<string, Snapshot>();

async function snapshotOf(viewer: Person, userId: string): Promise<Snapshot> {
  return { counters: await countersOf(viewer, userId), awards: await awardNames(viewer, userId) };
}

// ---- step 5, first half: the project is frozen -------------------------------------------------------------

export async function secondProjectIsFrozen(): Promise<void> {
  const [b, c, d] = [person('b'), person('c'), person('d')];
  const credit = await waitForCreditStatus(b, world.secondTeamId, 'frozen');
  // the participant is not told which rule fired (no signals of the anti-fraud for the users)
  const raw = await get(b, `/v1/teams/${world.secondTeamId}/credit`);
  expect(raw.text).not.toMatch(/signal|AF-\d|fraud/i);
  expect(credit.myCredits.every((row) => row.status !== 'credited')).toBe(true);
  for (const who of [b, c]) before.set(who.id, await snapshotOf(who, who.id));
  // the first project is credited, the frozen one adds nothing
  expect(before.get(b.id)?.counters.total).toBe(1);

  const { page } = b.session;
  await page.goto(ROUTES.credit(world.secondTeamId));
  await expect(creditUi.status(page)).toContainText(creditUi.statusText.frozen);
  await expect(creditUi.leakedRuleCode(page)).toHaveCount(0);
  await expectNoSeriousA11yViolations(page);
  expect((await get(d, `/v1/teams/${world.secondTeamId}/credit`)).status).toBe(404);
}

// ---- step 6: the complaint --------------------------------------------------------------------------------

export async function participantFilesAComplaint(): Promise<void> {
  const [b, c, d] = [person('b'), person('c'), person('d')];
  const { page } = b.session;
  await page.goto(ROUTES.credit(world.secondTeamId));
  await creditUi.dispute(page).click();
  await creditUi.disputeText(page).fill(world.disputeText);
  await expectNoSeriousA11yViolations(page);
  await creditUi.disputeSubmit(page).click();
  await expect(creditUi.disputeSent(page)).toBeVisible();

  // one complaint, and only a participant (IDOR) and only in the cooling window (FR-REW-11)
  const path = `/v1/teams/${world.secondTeamId}/disputes`;
  const again = await post(b, path, { text: world.disputeText });
  expect(again.status, again.text).toBe(409);
  const outsider = await post(d, path, { text: world.disputeText });
  expect([403, 404], outsider.text).toContain(outsider.status);
  const late = await post<{ code: string }>(c, `/v1/teams/${world.firstTeamId}/disputes`, {
    text: world.disputeText,
  });
  expect(late.status, late.text).toBe(409);
  expect(late.body.code).toBe('INVALID_STATE');
  await c.session.page.goto(ROUTES.credit(world.firstTeamId));
  await expect(creditUi.dispute(c.session.page)).toHaveCount(0);
}

// ---- step 5, second half: the administrator ----------------------------------------------------------------

async function nonAdministratorIsTurnedAway(): Promise<void> {
  const b = person('b');
  expect((await get(b, '/v1/admin/fraud-cases')).status).toBe(403);
  await b.session.page.goto(ROUTES.fraud);
  // a UX redirect only: the rights are checked by the api (S7-10)
  await expect(b.session.page).not.toHaveURL(/\/admin\/fraud/);
}

async function caseOfTheSecondProject(): Promise<CaseBody> {
  const admin = person('admin');
  const find = async (): Promise<CaseBody | undefined> => {
    const page = await get<CasePage>(admin, '/v1/admin/fraud-cases?status=open&limit=100');
    expect(page.status, page.text).toBe(200);
    return page.body.items.find((item) => item.teamId === world.secondTeamId);
  };
  await expect.poll(async () => (await find())?.id, { timeout: 30_000 }).toBeTruthy();
  const found = (await find()) as CaseBody;
  const card = await get<CaseBody>(admin, `/v1/admin/fraud-cases/${found.id}`);
  expect(card.status, card.text).toBe(200);
  expect(card.body.signals.map((s) => s.ruleCode)).toContain('AF-05');
  expect(card.body.disputes?.map((d) => d.text)).toContain(world.disputeText);
  // no more personal data than the review needs (FR-REW-16)
  expect(card.text).not.toMatch(/e-?mail|@/i);
  return card.body;
}

async function administratorDecidesInTheUi(): Promise<void> {
  const { page } = person('admin').session;
  await page.goto(ROUTES.fraud);
  await expect(fraudUi.heading(page)).toBeVisible();
  const item = fraudUi.caseItem(page, world.secondTeamName);
  await expect(item).toBeVisible();
  await expectNoSeriousA11yViolations(page);
  await fraudUi.openCase(item).click();
  await expect(fraudUi.signal(page, 'AF-05')).toBeVisible();
  await expect(fraudUi.disputes(page)).toContainText(world.disputeText);
  await expectNoSeriousA11yViolations(page);

  await fraudUi.comment(page).fill(world.decisionComment);
  await fraudUi.decide(page, 'violation').click();
  // the decision is final: it asks for a confirmation first
  await expect(fraudUi.confirmDialog(page)).toBeVisible();
  await fraudUi.confirm(page).click();
  await expect(fraudUi.decided(page)).toContainText(fraudUi.verdict.violation);
}

async function decisionIsFinalAndAudited(): Promise<void> {
  const admin = person('admin');
  const card = await get<CaseBody>(admin, `/v1/admin/fraud-cases/${world.caseId}`);
  expect(card.body).toMatchObject({ status: 'violation', comment: world.decisionComment });
  // CC-12: a decision that comes later, however many at once, is refused
  const later = await Promise.all(
    ['violation', 'ok', 'violation'].map((decision) =>
      post<{ code: string }>(admin, DECISION_PATH(world.caseId), {
        decision,
        comment: world.decisionComment,
      }),
    ),
  );
  for (const response of later) {
    expect(response.status, response.text).toBe(409);
    expect(response.body.code).toBe('INVALID_STATE');
  }
  // AF-25: who, what, when and why is written to the journal of the administrator
  const audited = sqlValue(
    `SELECT count(*) FROM rewards.admin_audit WHERE target_id = '${world.caseId}' AND length(reason) >= 10`,
  );
  expect(Number(audited)).toBeGreaterThanOrEqual(1);
}

async function violationLeavesTheTotalsWhereTheyWere(): Promise<void> {
  for (const key of ['b', 'c'] as const) {
    const who = person(key);
    const credit = await waitForCreditStatus(who, world.secondTeamId, 'revoked');
    expect(credit.myCredits.every((row) => row.status !== 'credited')).toBe(true);
    expect(await snapshotOf(who, who.id)).toEqual(before.get(who.id));
  }
  const b = person('b');
  const { page } = b.session;
  await page.goto(ROUTES.credit(world.secondTeamId));
  await expect(creditUi.status(page)).toContainText(creditUi.statusText.revoked);
  await page.goto(ROUTES.user(b.id));
  await expect(awardsUi.badge(page, BADGES.firstRelease)).toBeVisible();
  await expect(awardsUi.counters(page)).toContainText(
    awardsUi.counterText('Зачтённых проектов', 1),
  );
}

export async function administratorDecidesViolation(): Promise<void> {
  await nonAdministratorIsTurnedAway();
  world.caseId = (await caseOfTheSecondProject()).id;
  await administratorDecidesInTheUi();
  await decisionIsFinalAndAudited();
  await violationLeavesTheTotalsWhereTheyWere();
}
