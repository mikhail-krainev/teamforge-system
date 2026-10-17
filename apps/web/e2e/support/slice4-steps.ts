import { expect, type Page } from '@playwright/test';
import { expectNoSeriousA11yViolations } from './axe';
import { runWorkerJob } from './stack';
import { teamFormUi, teamPageUi, ROUTES as TEAM_ROUTES } from './slice3-ui';
import {
  bellUi,
  candidatesUi,
  demandUi,
  profileDemandUi,
  recommendationsUi,
  ROLE,
  ROUTES,
  searchUi,
  trialUi,
} from './slice4-ui';
import {
  demandOf,
  get,
  patch,
  person,
  post,
  saveCandidateProfile,
  teamAs,
  world,
  type ApplicationBody,
  type TeamBody,
} from './slice4-world';

/**
 * Step bodies of slice4.spec.ts (docs/plan.md, "Тесты среза" -> Playwright slice4.spec.ts, steps 1-8).
 *
 * The auto-add (step 4) is NOT driven by a test-only HTTP endpoint: the e2e stack runs api and worker
 * as `development` (support/stack.ts, APP_NODE_ENV), and the api has no `/v1/_test` door there (the
 * test support module belongs to the Vitest harness only). The scenario makes B eligible (his weekly
 * hours reach the seat's minimum) and runs one `matching-auto-add` pass through the worker CLI
 * (`runWorkerJob`), the same `AutoAddService.run()` the scheduled job calls, so no minute is waited for.
 */

const BACKEND_SEAT_MIN_HOURS = 30;

// ---- step 1: A creates a team with one open Backend seat --------------------------------------

export async function aCreatesTeamWithOpenBackendSeat(): Promise<void> {
  const { page } = person('a').session;
  await page.goto(TEAM_ROUTES.newTeam);
  await teamFormUi.name(page).fill(world.teamName);
  await teamFormUi.description(page).fill('Команда для сквозного сценария среза 4');
  await teamFormUi.productType(page).selectOption({ label: 'Веб-сервис' });
  await teamFormUi.hours(page).fill('10');
  await teamFormUi.addSeat(page).click();
  await teamFormUi.seatRole(page, 0).selectOption({ label: ROLE.backend.label });
  await teamFormUi.submit(page).click();
  await page.waitForURL(/\/teams\/[0-9a-f-]{36}$/, { timeout: 30_000 });
  world.teamId = page.url().split('/').pop() ?? '';
  await expect(teamPageUi.title(page, world.teamName)).toBeVisible();

  // The seat asks for more weekly hours than B has until step 4: the worker must leave B in the
  // queue while the demand showcase is checked (steps 2-3).
  const team = await teamAs(person('a'));
  const seat = team.seats.find((s) => s.roleCode === ROLE.backend.code && s.status === 'open');
  expect(seat, 'one open Backend seat').toBeDefined();
  world.seatId = seat?.id ?? '';
  const changed = await patch(
    person('a').session.context.request,
    `/v1/teams/${world.teamId}/seats/${world.seatId}`,
    {
      version: seat?.version,
      minHours: BACKEND_SEAT_MIN_HOURS,
    },
  );
  expect(changed.status, changed.text).toBe(200);
  expect(team.leadUserId).toBe(person('a').id);
}

// ---- step 2: B stands in the queue for Backend -------------------------------------------------

export async function bStandsInTheQueue(): Promise<void> {
  const b = person('b');
  const team = await teamAs(person('a'));
  await saveCandidateProfile(b, { hoursPerWeek: 10, timezone: team.timezone });
  const before = await demandOf(b, ROLE.backend.code);
  world.queuedBefore = before?.queuedCandidates ?? 0;

  const { page } = b.session;
  await page.goto(ROUTES.search);
  await expect(searchUi.heading(page)).toBeVisible();
  await expectNoSeriousA11yViolations(page);
  await searchUi.addRole(page).selectOption({ label: ROLE.backend.label });
  await searchUi.submit(page).click();
  await expect(searchUi.inQueue(page)).toBeVisible();
  await expect(searchUi.roles(page)).toContainText(ROLE.backend.label);

  const mine = await get<ApplicationBody>(b, '/v1/me/search-application');
  expect(mine.status, mine.text).toBe(200);
  expect(mine.body.status).toBe('active');
  expect(mine.body.roles).toEqual([expect.objectContaining({ roleCode: 'backend', priority: 1 })]);
  world.applicationId = mine.body.id;
  world.enqueuedAt = mine.body.enqueuedAt;
  await expectNoSeriousA11yViolations(page);
}

// ---- step 3: the demand showcase shows the queue and the open seat -----------------------------

async function demandCell(
  page: Page,
  column: 'openSeats' | 'teamsSeeking' | 'queued',
): Promise<number> {
  const row = demandUi.row(page, ROLE.backend.label);
  await expect(row).toBeVisible();
  const text = await row
    .getByRole('cell')
    .nth(demandUi.column[column] - 1)
    .innerText();
  return Number.parseInt(text.replace(/\D+/g, ''), 10);
}

export async function demandShowsTheQueue(): Promise<void> {
  const { page } = person('b').session;
  await page.goto(ROUTES.demand);
  await expect(demandUi.heading(page)).toBeVisible();
  await expect(demandUi.table(page)).toBeVisible();
  // The numbers are cached for a minute and recomputed on events (architecture 6.6): reload until they move.
  await expect
    .poll(
      async () => {
        await page.reload();
        await expect(demandUi.table(page)).toBeVisible();
        return [await demandCell(page, 'queued'), await demandCell(page, 'openSeats')];
      },
      { timeout: 60_000, intervals: [2_000, 3_000, 5_000] },
    )
    .toEqual([world.queuedBefore + 1, expect.any(Number)]);
  expect(await demandCell(page, 'openSeats')).toBeGreaterThanOrEqual(1);
  expect(await demandCell(page, 'teamsSeeking')).toBeGreaterThanOrEqual(1);
  await expectNoSeriousA11yViolations(page);
}

// ---- step 4: the auto-add fires ------------------------------------------------------------------

export async function autoAddFires(): Promise<void> {
  const b = person('b');
  const a = person('a');
  const team = await teamAs(a);
  // B is now eligible for the seat (hours >= the seat minimum, FR-MATCH-12 hard filter).
  await saveCandidateProfile(b, { hoursPerWeek: 40, timezone: team.timezone });
  // One run of the job now (the schedule would only come within a minute). The profile event may
  // not have reached the queue's view of B yet, so the run is repeated until B is a member.
  await expect
    .poll(
      async () => {
        runWorkerJob('matching-auto-add');
        const now = await teamAs(a);
        return now.members.some((m) => m.userId === b.id && m.status === 'active');
      },
      { timeout: 60_000, intervals: [1_000, 2_000, 3_000] },
    )
    .toBe(true);

  const joined = (await teamAs(a)).members.find((m) => m.userId === b.id);
  expect(joined?.joinedVia).toBe('auto');
  const trialMs = Date.parse(joined?.trialUntil ?? '') - Date.parse(joined?.joinedAt ?? '');
  expect(trialMs).toBeGreaterThan(6.9 * 24 * 3_600_000);
  expect(trialMs).toBeLessThan(7.1 * 24 * 3_600_000);

  const application = await get(b, '/v1/me/search-application');
  expect(application.status, 'a fulfilled application is no longer the active one').toBe(404);
}

// ---- step 5: B sees the trial badge, A got the notification ---------------------------------------

export async function bSeesTheTrialBadgeAndALearnsOfIt(): Promise<void> {
  const b = person('b');
  const a = person('a');
  await b.session.page.goto(TEAM_ROUTES.team(world.teamId));
  await expect(teamPageUi.member(b.session.page, b.name)).toBeVisible();
  await expect(trialUi.badge(b.session.page)).toBeVisible();
  await expectNoSeriousA11yViolations(b.session.page);

  await a.session.page.goto(TEAM_ROUTES.team(world.teamId));
  await expect(bellUi.unreadBadge(a.session.page)).toBeVisible({ timeout: 30_000 });
  await bellUi.button(a.session.page).click();
  await expect(bellUi.item(a.session.page, new RegExp(b.name, 'i')).first()).toBeVisible();
  await a.session.page.keyboard.press('Escape');
}

// ---- step 6: A excludes B, B is back in the queue with the same wait ----------------------------

export async function aExcludesBAndBIsBackInTheQueue(): Promise<void> {
  const a = person('a');
  const b = person('b');
  const { page } = a.session;
  await page.goto(TEAM_ROUTES.team(world.teamId));
  await expect(trialUi.exclude(page, b.name)).toBeVisible();
  await expectNoSeriousA11yViolations(page);
  await trialUi.exclude(page, b.name).click();
  await trialUi.excludeYes(page).click();
  await expect(trialUi.excluded(page)).toBeVisible();

  const team = await teamAs(a);
  expect(team.members.find((m) => m.userId === b.id && m.status === 'active')).toBeUndefined();
  expect(team.seats.find((s) => s.id === world.seatId)?.status).toBe('open');

  // FR-MATCH-08: the same application is active again, with the same enqueuedAt.
  await expect
    .poll(async () => (await get<ApplicationBody>(b, '/v1/me/search-application')).status, {
      timeout: 30_000,
    })
    .toBe(200);
  const restored = await get<ApplicationBody>(b, '/v1/me/search-application');
  expect(restored.body).toMatchObject({
    id: world.applicationId,
    status: 'active',
    enqueuedAt: world.enqueuedAt,
  });
  await b.session.page.goto(ROUTES.search);
  await expect(searchUi.inQueue(b.session.page)).toBeVisible();
}

// ---- step 7: B finds ANOTHER team in the recommendations and applies -----------------------------

/**
 * World setup of the step: C leads a second team with one open Backend seat. A's team excluded B in
 * step 6 and is therefore never recommended to him again (FR-MATCH-08), so the recommendation has
 * to come from another team. The seat is chosen so that the auto-add must not take B in before he
 * applies (the score stays below the 0.5 threshold, C-45): it asks for a TypeScript stack B does not
 * have (stack 0), at the lowest level (0.5 of the level share) and few hours.
 */
async function cLeadsAnotherTeamWithOpenBackendSeat(): Promise<void> {
  const c = person('c');
  const created = await post<TeamBody>(c, '/v1/teams', {
    name: world.otherTeamName,
    description: 'Вторая команда для сквозного сценария среза 4',
    timezone: (await teamAs(person('a'))).timezone,
    hoursPerWeek: 10,
    productTypeCode: 'web_service',
    seats: [
      {
        roleCode: ROLE.backend.code,
        desired: false,
        minLevel: 'beginner',
        minHours: 3,
        stack: ['typescript'],
        count: 1,
      },
    ],
  });
  expect(created.status, created.text).toBe(201);
  world.otherTeamId = created.body.id;
  const seat = created.body.seats.find((s) => s.roleCode === ROLE.backend.code);
  expect(seat?.status, 'one open Backend seat of the second team').toBe('open');
  world.otherSeatId = seat?.id ?? '';
}

export async function bAppliesFromTheRecommendations(): Promise<void> {
  const b = person('b');
  await cLeadsAnotherTeamWithOpenBackendSeat();
  const { page } = b.session;
  await page.goto(ROUTES.search);
  await expect(recommendationsUi.heading(page)).toBeVisible();
  // The recommendations are precomputed 5 s after the events (architecture 6.3): reload until the team is there.
  await expect
    .poll(
      async () => {
        await page.reload();
        await expect(recommendationsUi.heading(page)).toBeVisible();
        return recommendationsUi.apply(page, world.otherTeamName).count();
      },
      { timeout: 60_000, intervals: [2_000, 3_000, 5_000] },
    )
    .toBe(1);
  // FR-MATCH-08: the team that excluded B in the trial is not offered to him again.
  await expect(recommendationsUi.apply(page, world.teamName)).toHaveCount(0);
  await expectNoSeriousA11yViolations(page);
  await recommendationsUi.apply(page, world.otherTeamName).click();
  await expect(recommendationsUi.applied(page)).toBeVisible();

  const requests = await get<{ items: { seatId: string; direction: string; status: string }[] }>(
    b,
    '/v1/me/seat-offers',
  );
  expect(requests.status, requests.text).toBe(200);
  expect(requests.body.items).toContainEqual(
    expect.objectContaining({
      seatId: world.otherSeatId,
      direction: 'user_to_lead',
      status: 'pending',
    }),
  );
  expect(requests.body.items).not.toContainEqual(expect.objectContaining({ seatId: world.seatId }));
  // FR-TEAM-29: the join request does not touch the queue.
  const stillQueued = await get<ApplicationBody>(b, '/v1/me/search-application');
  expect(stillQueued.status).toBe(200);
}

// ---- step 8: every page of the slice is accessible -----------------------------------------------

export async function everyPageOfTheSliceIsAccessible(): Promise<void> {
  const b = person('b');
  const a = person('a');
  for (const route of [ROUTES.search, ROUTES.demand, ROUTES.profile]) {
    await b.session.page.goto(route);
    await expect(b.session.page.getByRole('main')).toBeVisible();
    if (route === ROUTES.profile) await expect(profileDemandUi.block(b.session.page)).toBeVisible();
    await expectNoSeriousA11yViolations(b.session.page);
  }
  // The seat candidates of the team that B applied to (A's team excluded him, FR-MATCH-08: B is no
  // candidate of its seat any more).
  const c = person('c');
  await c.session.page.goto(ROUTES.seat(world.otherTeamId, world.otherSeatId));
  await expect(candidatesUi.list(c.session.page)).toBeVisible({ timeout: 45_000 });
  await expect(candidatesUi.offer(c.session.page, b.name)).toBeVisible();
  await expectNoSeriousA11yViolations(c.session.page);
  await a.session.page.goto(TEAM_ROUTES.team(world.teamId));
  await expectNoSeriousA11yViolations(a.session.page);
  await c.session.page.goto(TEAM_ROUTES.team(world.otherTeamId));
  await expectNoSeriousA11yViolations(c.session.page);
}
