import { randomUUID } from 'node:crypto';
import { expect } from '@playwright/test';
import type { TwinAccount } from '../../../api/test/fakes/github-app';
import { ORIGIN_HEADERS } from './api';
import { expectNoSeriousA11yViolations } from './axe';
import { routeInstallDialogToDouble } from './github';
import * as slice5steps from './slice5-steps';
import { artifactFile, backdateStage, itemOf, patchItem, stages } from './slice5-world';
import { WEB_ORIGIN } from './slice3-world';
import { completeUi, feedUi, githubUi, ROUTES } from './slice6-ui';
import {
  ageReleaseChecks,
  deliver,
  DISPLAY_NAMES,
  double,
  get,
  githubOf,
  makeProjectOlder,
  person,
  post,
  put,
  teamId,
  world,
  type GithubIdentityRef,
  type Person,
} from './slice6-world';

/**
 * Step bodies of slice6.spec.ts (docs/plan.md, "Тесты среза" -> Playwright slice6.spec.ts, steps 1-8),
 * written before the implementation (S6-02): they must fail until slice 6 is done.
 *
 * What is under test is driven through the UI (install, link, feed, relabel, checks, completion); what is
 * only setup goes through the API: the playbook and the team (slice 5 steps), the stages of the route
 * (`finishStages`), the second team. GitHub is the double of apps/api/test/fakes/github-app.ts, which
 * also sends the webhooks (the application is reached through the web origin like in production). Time is
 * skipped by moving the throwaway database (support/slice6-world.ts), the way slice 5 skips 24 hours.
 *
 * Requirements of this scenario beyond slice 5:
 *   - the e2e compose project passes GITHUB_APP_ID, GITHUB_APP_SLUG, GITHUB_APP_PRIVATE_KEY and
 *     GITHUB_WEBHOOK_SECRET to api and worker (githubComposeEnv() in support/github.ts provides them);
 *   - the release address answers a working page to the link-checker container (step 6 needs the internet,
 *     or E2E_RELEASE_URL pointing at a page the container can reach), otherwise the check `release_alive`
 *     stays red and "Завершить" is correctly refused.
 */

const RELEASE_URL = process.env.E2E_RELEASE_URL ?? 'https://www.wikipedia.org/';
const REVIEW_ANSWERS = [1, 2, 3].map((ordinal) => ({ ordinal, answer: true }));

interface RepositoryBody {
  repositoryId: number;
  fullName: string;
  installationId: number;
  status: string;
}

interface FeedBody {
  items: { id: string; title: string; roleCode: string; userId: string; source: string }[];
  nextCursor: string | null;
}

// ---- setup: the playbook, the team, the first team's route is slice 5 -----------------------------

export async function setupPlaybookAndStartedTeam(): Promise<void> {
  await slice5steps.adminPublishesThePlaybook();
  await slice5steps.teamOfThreeStartsTheProject();
}

// ---- step 1: the lead installs the App and binds the repository ----------------------------------

let sharedOrganization: TwinAccount | undefined;

async function queueInstall(who: Person, repoName?: string): Promise<GithubIdentityRef> {
  const server = await double();
  const [a, d, b, c] = await Promise.all([
    githubOf(person('a')),
    githubOf(person('d')),
    githubOf(person('b')),
    githubOf(person('c')),
  ]);
  sharedOrganization ??= {
    id: 9_500_000 + (Date.now() % 100_000),
    login: `e2e-org-${Date.now()}`,
    type: 'Organization',
    ownerIds: [a.id, d.id],
  };
  const me = await githubOf(who);
  server.app.queueBrowserInstall(
    me,
    sharedOrganization,
    repoName
      ? {
          repos: [
            {
              name: repoName,
              createdAt: new Date().toISOString(),
              contributors: [b, c].map((p) => ({ ...p, contributions: 8 })),
            },
          ],
        }
      : {},
  );
  await routeInstallDialogToDouble(who.session.context);
  return me;
}

export async function leadInstallsTheAppAndBindsTheRepository(): Promise<void> {
  const a = person('a');
  const repoName = `teamforge-e2e-${Date.now()}`;
  await queueInstall(a, repoName);
  const { page } = a.session;
  await page.goto(ROUTES.github(teamId()));
  await expect(githubUi.heading(page)).toBeVisible();
  await expect(githubUi.projectsHint(page)).toBeVisible();
  await expectNoSeriousA11yViolations(page);

  await githubUi.install(page).click();
  // GitHub (the double) sends the browser to Callback URL #1, the api redirects into the web app
  await page.waitForURL((url) => url.origin === WEB_ORIGIN && !url.pathname.startsWith('/api'), {
    timeout: 60_000,
  });
  await expect(githubUi.installed(page)).toBeVisible({ timeout: 30_000 });
  const fullName = `${sharedOrganization?.login}/${repoName}`;
  await expect(githubUi.repository(page, fullName)).toBeVisible();
  await githubUi.repository(page, fullName).check();
  await githubUi.link(page).click();
  await expect(githubUi.linked(page, fullName)).toBeVisible({ timeout: 30_000 });
  await expectNoSeriousA11yViolations(page);

  const stored = await get<RepositoryBody>(person('b'), `/v1/teams/${teamId()}/repository`);
  expect(stored.status, stored.text).toBe(200);
  expect(stored.body).toMatchObject({ fullName, status: 'active' });
  world.repo = {
    id: stored.body.repositoryId,
    fullName,
    installationId: stored.body.installationId,
  };
}

// ---- step 2: the double sends the webhooks ---------------------------------------------------------

type Twin = Awaited<ReturnType<typeof double>>['app'];

/** B and C close six issues and merge four pull requests: the ten contributions FR-WORK-13 asks for. */
async function deliverTheWork(
  app: Twin,
  repoId: number,
  b: GithubIdentityRef,
  c: GithubIdentityRef,
): Promise<{ titles: string[]; lastIssue: ReturnType<Twin['openIssue']> }> {
  const titles: string[] = [];
  let lastIssue: ReturnType<Twin['openIssue']> | undefined;
  const closedIssue = async (author: GithubIdentityRef, title: string): Promise<void> => {
    titles.push(title);
    const item = app.openIssue(repoId, { author, assignees: [author], title });
    expect(await deliver(app.issuesEvent('opened', item))).toBe(202);
    app.closeIssue(repoId, item.number);
    expect(await deliver(app.issuesEvent('closed', item))).toBe(202);
    lastIssue = item;
  };
  const mergedPull = async (author: GithubIdentityRef, title: string): Promise<void> => {
    titles.push(title);
    const item = app.openPull(repoId, { author, title });
    expect(await deliver(app.pullRequestEvent('opened', item))).toBe(202);
    app.mergePull(repoId, item.number);
    expect(await deliver(app.pullRequestEvent('closed', item))).toBe(202);
  };
  for (const n of [1, 2, 3]) {
    await closedIssue(b, `Доработать API ${n}`);
    await closedIssue(c, `Починить форму ${n}`);
  }
  await mergedPull(b, 'PR: сервис авторизации');
  for (const n of [1, 2, 3]) await mergedPull(c, `PR: страница ${n}`);
  if (!lastIssue) throw new Error('no issue was delivered');
  return { titles, lastIssue };
}

export async function doubleSendsIssueAndPullRequestWebhooks(): Promise<void> {
  const app = (await double()).app;
  const [b, c] = await Promise.all([githubOf(person('b')), githubOf(person('c'))]);
  const repoId = world.repo.id;
  expect(repoId).toBeGreaterThan(0);
  const { titles, lastIssue } = await deliverTheWork(app, repoId, b, c);
  world.titles = titles;

  // a delivery with a wrong signature is refused and leaves no trace (FR-GH-03); a repeated one is accepted and ignored (FR-GH-04)
  const forged = app.issuesEvent('closed', app.openIssue(repoId, { author: b, assignees: [b] }), {
    signature: 'invalid',
  });
  expect(await deliver(forged)).toBe(401);
  const once = app.issuesEvent('closed', lastIssue);
  expect(await deliver(once)).toBe(202);
  expect(await deliver(once)).toBe(202);

  await expect
    .poll(
      async () => {
        const feed = await get<FeedBody>(person('a'), `/v1/teams/${teamId()}/feed?limit=100`);
        return feed.body.items.filter((i) => titles.includes(i.title)).length;
      },
      { timeout: 60_000, intervals: [500, 1_000, 2_000] },
    )
    .toBe(titles.length);
}

// ---- step 3: the feed shows the entries with the executor and the role -----------------------------

export async function feedShowsEntriesWithExecutorAndRole(): Promise<void> {
  const { page } = person('b').session;
  await page.goto(ROUTES.feed(teamId()));
  await expect(feedUi.heading(page)).toBeVisible();
  for (const title of world.titles) await expect(feedUi.entry(page, title)).toBeVisible();

  const issue = feedUi.entry(page, 'Доработать API 1');
  await expect(issue).toContainText(DISPLAY_NAMES.b);
  await expect(issue).toContainText(/backend/i);
  const pull = feedUi.entry(page, 'PR: страница 1');
  await expect(pull).toContainText(DISPLAY_NAMES.c);
  await expect(pull).toContainText(/frontend/i);

  await feedUi.executor(page).selectOption({ label: DISPLAY_NAMES.c });
  await expect(feedUi.entries(page)).toHaveCount(6);
  await expect(feedUi.entry(page, 'Доработать API 1')).toHaveCount(0);
  await feedUi.executor(page).selectOption({ index: 0 });
  await expect(feedUi.entries(page)).toHaveCount(world.titles.length);

  await expect(feedUi.summary(page)).toContainText(DISPLAY_NAMES.b);
  await expect(feedUi.summary(page)).toContainText(DISPLAY_NAMES.c);
  await expectNoSeriousA11yViolations(page);
}

// ---- step 4: a member changes the role of a contribution ------------------------------------------

/** Setup: B takes a second seat (DevOps), so he holds two roles and has a role to choose. */
async function bHoldsTheDevOpsRoleToo(): Promise<void> {
  const [a, b] = [person('a'), person('b')];
  const added = await post(a, `/v1/teams/${teamId()}/seats`, {
    seats: [
      { roleCode: 'devops', desired: false, minLevel: 'junior', minHours: 3, stack: [], count: 1 },
    ],
  });
  expect(added.status, added.text).toBe(201);
  const team = await get<{ seats: { id: string; roleCode: string; status: string }[] }>(
    a,
    `/v1/teams/${teamId()}`,
  );
  const seat = team.body.seats.find((s) => s.roleCode === 'devops' && s.status === 'open');
  expect(seat, 'the open DevOps seat').toBeDefined();
  const offer = await post<{ id: string }>(a, `/v1/teams/${teamId()}/seat-offers`, {
    seatId: seat?.id,
    userId: b.id,
  });
  expect(offer.status, offer.text).toBe(201);
  const accepted = await post(b, `/v1/seat-offers/${offer.body.id}/acceptance`);
  expect(accepted.status, accepted.text).toBe(200);
}

export async function memberChangesTheRoleOfAContribution(): Promise<void> {
  await bHoldsTheDevOpsRoleToo();
  const b = person('b');
  const { page } = b.session;
  await page.goto(ROUTES.feed(teamId()));
  const entry = feedUi.entry(page, 'Доработать API 1');
  await expect(entry).toContainText(/backend/i);
  await feedUi.relabel(entry).click();
  await feedUi.newRole(page).selectOption('devops');
  await expectNoSeriousA11yViolations(page);
  await feedUi.relabelConfirm(page).click();
  await expect(entry).toContainText(/devops/i);
  await expect(entry).not.toContainText(/backend/i);

  const feed = await get<FeedBody>(person('a'), `/v1/teams/${teamId()}/feed?limit=100`);
  expect(feed.body.items.find((i) => i.title === 'Доработать API 1')?.roleCode).toBe('devops');
  // the entries of somebody else cannot be relabelled: no button on the entry of C
  await expect(feedUi.relabel(feedUi.entry(page, 'PR: страница 1'))).toHaveCount(0);
}

// ---- step 5: the second team meets REPO_TAKEN -----------------------------------------------------

export async function secondTeamMeetsRepoTaken(): Promise<void> {
  const d = person('d');
  const created = await post<{ id: string }>(d, '/v1/teams', {
    name: world.otherTeamName,
    description: 'Вторая команда, которой нужен тот же репозиторий',
    timezone: 'Europe/Moscow',
    hoursPerWeek: 10,
    productTypeCode: 'web_service',
    seats: [
      { roleCode: 'backend', desired: false, minLevel: 'junior', minHours: 3, stack: [], count: 1 },
    ],
  });
  expect(created.status, created.text).toBe(201);
  world.otherTeamId = created.body.id;

  await queueInstall(d);
  const { page } = d.session;
  await page.goto(ROUTES.github(world.otherTeamId));
  await githubUi.install(page).click();
  await page.waitForURL((url) => url.origin === WEB_ORIGIN && !url.pathname.startsWith('/api'), {
    timeout: 60_000,
  });
  await expect(githubUi.installed(page)).toBeVisible({ timeout: 30_000 });
  await githubUi.repository(page, world.repo.fullName).check();
  await githubUi.link(page).click();
  await expect(githubUi.taken(page)).toBeVisible();
  await expectNoSeriousA11yViolations(page);

  const other = await get(d, `/v1/teams/${world.otherTeamId}/repository`);
  expect(other.status).toBe(404);
  const first = await get<RepositoryBody>(person('a'), `/v1/teams/${teamId()}/repository`);
  expect(first.body).toMatchObject({ fullName: world.repo.fullName, status: 'active' });
}

// ---- step 6: the release stage: the link, the checks, the second check of the release --------------

async function upload(who: Person, itemId: string, name: string): Promise<void> {
  const response = await who.session.context.request.post(
    `/api/v1/teams/${teamId()}/checklist-items/${itemId}/files`,
    {
      multipart: { file: artifactFile(name) },
      headers: { ...ORIGIN_HEADERS, 'Idempotency-Key': randomUUID() },
    },
  );
  expect(response.status(), await response.text()).toBe(201);
}

async function doneWith(
  who: Person,
  stepKey: string,
  ordinal: number,
  body: Record<string, unknown> = {},
) {
  const item = await itemOf(who, stepKey, ordinal);
  return patchItem(who, item, { status: 'done', ...body });
}

/** Setup: stages 1 and 2 of the mini playbook are done and closed through the API (slice 5 is tested elsewhere). */
async function finishStages(): Promise<void> {
  const [a, b, c] = [person('a'), person('b'), person('c')];
  const today = new Date().toISOString().slice(0, 10);
  await doneWith(b, 'mini_kickoff', 1, {
    heldOn: today,
    externalUrl: 'https://meet.example.org/kickoff',
    outcome: 'Договорились о цели, ролях и правилах работы команды.',
  });
  const board = await itemOf(c, 'mini_board', 1);
  await patchItem(c, board, { linkUrl: 'https://example.org/team-board' });
  await doneWith(c, 'mini_board', 1);
  const charter = await itemOf(a, 'mini_charter', 1);
  const assigned = await put(a, `/v1/teams/${teamId()}/checklist-items/${charter.id}/assignee`, {
    version: charter.version,
    userId: c.id,
  });
  expect(assigned.status, assigned.text).toBe(200);
  await upload(c, charter.id, 'charter.pdf');
  await doneWith(c, 'mini_charter', 1);
  const spec = await itemOf(b, 'mini_spec', 1);
  await upload(b, spec.id, 'spec.pdf');
  await doneWith(b, 'mini_spec', 1);
  const reviewed = await itemOf(c, 'mini_spec', 1);
  const review = await put(c, `/v1/teams/${teamId()}/checklist-items/${reviewed.id}/review`, {
    version: reviewed.version,
    answers: REVIEW_ANSWERS,
  });
  expect(review.status, review.text).toBe(200);
  await moveOn(1);

  const design = await itemOf(c, 'mini_design', 2);
  await upload(c, design.id, 'design.pdf');
  await doneWith(c, 'mini_design', 2);
  await doneWith(b, 'mini_retro', 2, {
    heldOn: today,
    externalUrl: 'https://meet.example.org/retro',
    outcome: 'Что получилось, что нет и что меняем на следующем этапе.',
  });
  await moveOn(2);
  expect((await stages(a)).map((s) => s.status)).toEqual(['closed', 'closed', 'open']);
}

/** The 24 hours of C-08 are skipped, then the lead presses "Перейти" through the API. */
async function moveOn(ordinal: number): Promise<void> {
  backdateStage(teamId(), ordinal);
  const moved = await post(person('a'), `/v1/teams/${teamId()}/stage-transitions`, {
    fromOrdinal: ordinal,
  });
  expect(moved.status, moved.text).toBe(201);
}

export async function leadPastesTheReleaseLinkAndRunsTheChecks(): Promise<void> {
  await finishStages();
  const a = person('a');
  const { page } = a.session;
  await page.goto(ROUTES.complete(teamId()));
  await expect(completeUi.heading(page)).toBeVisible();
  await completeUi.releaseLink(page).fill(RELEASE_URL);
  await completeUi.saveRelease(page).click();
  // the first check of the release is made when the link is saved (FR-WORK-14)
  await expect
    .poll(async () => (await itemOf(a, 'mini_final_links', 3)).linkUrl, { timeout: 30_000 })
    .toBe(RELEASE_URL);
  const finalLinks = await itemOf(a, 'mini_final_links', 3);
  if (finalLinks.status !== 'done') await patchItem(a, finalLinks, { status: 'done' });

  await completeUi.runChecks(page).click();
  await expect(completeUi.checks(page)).toBeVisible({ timeout: 60_000 });
  // the second check of the release is not earlier than 24 hours after the first: the screen says when
  await expect(completeUi.secondCheckTimer(page)).toBeVisible();
  await expect(completeUi.check(page, /релиз/i)).toContainText(completeUi.failed);
  await expectNoSeriousA11yViolations(page);

  // the last stage closes (a day on it, then "Перейти"), the project is two weeks old, the first release check is a day old
  backdateStage(teamId(), 3);
  makeProjectOlder(teamId());
  ageReleaseChecks(teamId());
  await page.reload();
  await completeUi.runChecks(page).click();
  for (const check of [/репозиторий/i, /релиз/i]) {
    await expect(completeUi.check(page, check)).toContainText(completeUi.passed, {
      timeout: 90_000,
    });
  }
  await expect(completeUi.finish(page)).toBeEnabled();
  await expectNoSeriousA11yViolations(page);
}

// ---- step 7: "Завершить" gives the results screen with the snapshot; a second press is impossible ----

export async function leadCompletesTheProject(): Promise<void> {
  const a = person('a');
  const { page } = a.session;
  // the closing of the last stage is the lead's "Перейти" (slice 5); the wizard needs every stage closed
  const closing = await post(a, `/v1/teams/${teamId()}/stage-transitions`, { fromOrdinal: 3 });
  expect([201, 409], closing.text).toContain(closing.status);
  await page.goto(ROUTES.complete(teamId()));
  await completeUi.runChecks(page).click();
  await expect(completeUi.finish(page)).toBeEnabled({ timeout: 90_000 });
  await completeUi.finish(page).click();
  await completeUi.finishConfirm(page).click();

  await expect(completeUi.resultsHeading(page)).toBeVisible({ timeout: 30_000 });
  await expect(completeUi.overdue(page)).toContainText(/без просрочки/i);
  const composition = completeUi.composition(page);
  for (const name of [DISPLAY_NAMES.a, DISPLAY_NAMES.b, DISPLAY_NAMES.c]) {
    await expect(composition).toContainText(name);
  }
  const contributions = completeUi.contributions(page);
  await expect(contributions).toContainText(/devops/i);
  await expect(contributions).toContainText(/backend/i);
  await expect(contributions).toContainText(/frontend/i);
  await expectNoSeriousA11yViolations(page);

  // a second press is impossible: no button any more, and the api refuses it
  await expect(completeUi.finish(page)).toHaveCount(0);
  await page.reload();
  await expect(completeUi.resultsHeading(page)).toBeVisible();
  await expect(completeUi.finish(page)).toHaveCount(0);
  const again = await post<{ code: string }>(a, `/v1/teams/${teamId()}/completion`);
  expect(again.status, again.text).toBe(409);
  expect(again.body.code).toBe('INVALID_STATE');

  // every participant sees the same results (FR-WORK-15)
  const bPage = person('b').session.page;
  await bPage.goto(ROUTES.complete(teamId()));
  await expect(completeUi.resultsHeading(bPage)).toBeVisible();
  await expect(completeUi.overdue(bPage)).toContainText(/без просрочки/i);
}

// ---- step 8: every page of the slice is accessible ---------------------------------------------------

export async function everyPageOfTheSliceIsAccessible(): Promise<void> {
  const b = person('b').session.page;
  const a = person('a').session.page;
  for (const [page, url] of [
    [a, ROUTES.github(teamId())],
    [b, ROUTES.feed(teamId())],
    [b, ROUTES.complete(teamId())],
    [a, ROUTES.complete(teamId())],
  ] as const) {
    await page.goto(url);
    await expect(page.getByRole('main')).toBeVisible();
    await expectNoSeriousA11yViolations(page);
  }
}
