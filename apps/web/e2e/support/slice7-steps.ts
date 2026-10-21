import { expect, type Page } from '@playwright/test';
import { expectNoSeriousA11yViolations } from './axe';
import { world as routeWorld } from './slice5-world';
import { teamId } from './slice6-world';
import { awardsUi, BADGES, creditUi, ROUTES } from './slice7-ui';
import {
  advanceCooling,
  awardNames,
  countersOf,
  get,
  person,
  runCliJob,
  waitForCreditStatus,
  world,
  type Person,
} from './slice7-world';

/**
 * Step bodies of slice7.spec.ts (docs/plan.md, "Тесты среза" -> Playwright slice7.spec.ts, steps 1-7),
 * written before the implementation (S7-01): they must fail until slice 7 is done.
 *
 * This file: step 1 (the fixture, the project of slice 6 is finished), steps 2 and 3 (the cooling, the
 * credit, the badges and the counters) and step 7 (axe). Step 4 (the reviews) is in
 * support/slice7-review-steps.ts, steps 5 and 6 (the frozen project, the complaint, the decision of the
 * administrator) in support/slice7-fraud-steps.ts, the second project in support/slice7-project-steps.ts.
 *
 * What is under test is driven through the UI; setup and the negative cases of the API go through the API.
 * Time is skipped by moving the throwaway database and running the worker jobs once (support/slice7-world.ts).
 * Credits are asserted for B and C: the lead A has no contribution of his own in the fixture of slice 6
 * (FR-REW-01, condition 2), so his own credit is not part of the scenario.
 */

export * from './slice7-fraud-steps';
export * from './slice7-project-steps';
export * from './slice7-review-steps';

const DAY_MS = 86_400_000;
/** The seven days of the cooling (C-17b) and one more day, so that the end is surely behind us. */
const COOLING_DAYS_SKIPPED = 8;

const ROLES_OF = {
  b: [/backend/i, /devops/i],
  c: [/frontend/i],
} as const;

// ---- step 1: the fixture, the finished project of slices 3-6 ---------------------------------------

export async function firstProjectIsFinished(): Promise<void> {
  world.firstTeamId = teamId();
  world.firstTeamName = routeWorld.teamName;
  expect(world.firstTeamId, 'the team of slice 6 is known').not.toBe('');
  for (const key of ['a', 'b', 'c'] as const) {
    const completion = await get(person(key), `/v1/teams/${world.firstTeamId}/completion`);
    expect(completion.status, completion.text).toBe(200);
  }
}

// ---- step 2: the cooling and the credit --------------------------------------------------------------

export async function participantSeesTheCooling(): Promise<void> {
  const [b, d] = [person('b'), person('d')];
  const credit = await waitForCreditStatus(b, world.firstTeamId, 'cooling');
  const daysLeft = (Date.parse(credit.coolingUntil) - Date.now()) / DAY_MS;
  expect(daysLeft).toBeGreaterThan(6);
  expect(daysLeft).toBeLessThanOrEqual(7.01);
  // nothing is applied during the cooling (FR-REW-11)
  expect((await countersOf(b, b.id)).total).toBe(0);
  expect(await awardNames(b, b.id)).toEqual([]);

  const { page } = b.session;
  await page.goto(ROUTES.credit(world.firstTeamId));
  await expect(creditUi.heading(page)).toBeVisible();
  await expect(creditUi.status(page)).toContainText(creditUi.statusText.cooling);
  await expect(creditUi.countdown(page)).toContainText(/\d/);
  await expect(creditUi.leakedRuleCode(page)).toHaveCount(0);
  await expectNoSeriousA11yViolations(page);

  // IDOR: an outsider does not see that the project exists
  const outsider = await get(d, `/v1/teams/${world.firstTeamId}/credit`);
  expect(outsider.status, outsider.text).toBe(404);
}

async function seesTheCredit(who: Person, roles: readonly RegExp[]): Promise<void> {
  const credit = await waitForCreditStatus(who, world.firstTeamId, 'credited');
  expect(credit.myCredits.length).toBeGreaterThan(0);
  const { page } = who.session;
  await page.goto(ROUTES.credit(world.firstTeamId));
  await expect(creditUi.status(page)).toContainText(creditUi.statusText.credited);
  for (const role of roles) {
    await expect(creditUi.myCredit(page, role)).toContainText(creditUi.statusText.credited);
  }
  await expect(creditUi.countdown(page)).toHaveCount(0);
  await expectNoSeriousA11yViolations(page);
}

export async function coolingEndsAndTheProjectIsCredited(): Promise<void> {
  advanceCooling(world.firstTeamId, COOLING_DAYS_SKIPPED);
  for (const key of ['b', 'c'] as const) await seesTheCredit(person(key), ROLES_OF[key]);

  // CC-6: a second run of the credit changes nothing (counters +1 once, awards without duplicates)
  runCliJob('rewards-cooling-end');
  for (const key of ['b', 'c'] as const) {
    const who = person(key);
    expect((await countersOf(who, who.id)).total).toBe(1);
    const names = await awardNames(who, who.id);
    expect(names.filter((name) => name === BADGES.firstRelease)).toHaveLength(1);
  }
}

// ---- step 3: the badge and the counter on the profile ------------------------------------------------

async function expectAwardsBlock(page: Page, url: string, backendCount?: number): Promise<void> {
  await page.goto(url);
  await expect(awardsUi.region(page)).toBeVisible();
  const first = awardsUi.badge(page, BADGES.firstRelease);
  await expect(first).toBeVisible();
  await expect(first).toContainText(awardsUi.step(1));
  await expect(awardsUi.badge(page, BADGES.onTime)).toBeVisible();
  await expect(awardsUi.counters(page)).toContainText(
    awardsUi.counterText('Зачтённых проектов', 1),
  );
  if (backendCount !== undefined) {
    await expect(awardsUi.counters(page)).toContainText(
      awardsUi.counterText('Backend', backendCount),
    );
  }
  await expect(awardsUi.catalogItem(page, BADGES.collector)).toContainText(awardsUi.unavailable);
}

interface BadgeCatalog {
  items: { code: string; name: string; available: boolean }[];
}

async function publicApiHidesTheInternals(viewer: Person, ownerId: string): Promise<void> {
  const awards = await get(viewer, `/v1/users/${ownerId}/awards`);
  const counters = await get(viewer, `/v1/users/${ownerId}/counters`);
  for (const response of [awards, counters]) {
    expect(response.status, response.text).toBe(200);
    expect(response.text).not.toMatch(/signal|fraud|roster|score|reason|AF-\d/i);
  }
  const catalog = await get<BadgeCatalog>(viewer, '/v1/badges');
  expect(catalog.status, catalog.text).toBe(200);
  const collector = catalog.body.items.find((badge) => badge.name === BADGES.collector);
  expect(collector?.available, 'the step 4 of "Типы продукта" is not reachable in the MVP').toBe(
    false,
  );
}

export async function badgeAndCounterAppearOnTheProfile(): Promise<void> {
  const [a, b, c] = [person('a'), person('b'), person('c')];
  // the own profile and the page of the person (S7-08: the block is on both)
  await expectAwardsBlock(b.session.page, ROUTES.ownProfile, 1);
  await expectAwardsBlock(b.session.page, ROUTES.user(b.id), 1);
  await expectAwardsBlock(c.session.page, ROUTES.ownProfile);
  // the page of somebody else (FR-PROF-06)
  await expectAwardsBlock(a.session.page, ROUTES.user(b.id), 1);
  await expectAwardsBlock(a.session.page, ROUTES.user(c.id));
  await expectNoSeriousA11yViolations(a.session.page);
  await publicApiHidesTheInternals(a, b.id);
  // the names that the badges carry are the ones of the table of FR-REW-05
  expect(await awardNames(a, c.id)).toEqual(expect.arrayContaining([BADGES.firstRelease]));
}

// ---- step 7: every page of the slice is accessible ---------------------------------------------------

export async function everyPageOfTheSliceIsAccessible(): Promise<void> {
  const [admin, a, b, c] = [person('admin'), person('a'), person('b'), person('c')];
  const pages: [Page, string][] = [
    [b.session.page, ROUTES.credit(world.firstTeamId)],
    [b.session.page, ROUTES.credit(world.secondTeamId)],
    [a.session.page, ROUTES.user(b.id)],
    [c.session.page, ROUTES.ownProfile],
    [c.session.page, ROUTES.reviews],
    [admin.session.page, ROUTES.fraud],
  ];
  for (const [page, url] of pages) {
    await page.goto(url);
    await expect(page.getByRole('main')).toBeVisible();
    await expectNoSeriousA11yViolations(page);
  }
}
