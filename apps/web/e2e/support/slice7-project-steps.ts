import { randomUUID } from 'node:crypto';
import { expect } from '@playwright/test';
import { ORIGIN_HEADERS } from './api';
import { CHECKS_TEST_TIMEOUT_MS } from './slice6-steps';
import * as slice5steps from './slice5-steps';
import {
  artifactFile,
  backdateStage,
  itemOf,
  patchItem,
  stages,
  world as routeWorld,
} from './slice5-world';
import { completeUi, ROUTES as SLICE6_ROUTES } from './slice6-ui';
import {
  ageReleaseChecks,
  deliver,
  double,
  get,
  githubOf,
  makeProjectOlder,
  post,
  put,
  world as githubWorld,
  type GithubIdentityRef,
  type Person,
} from './slice6-world';
import { person, world } from './slice7-world';

/**
 * The second project of slice 7 (step 5): the same three people start a team on the published scenario,
 * bind a second repository (the step of slice 6 does it), deliver ten contributions in tiny pull
 * requests (AF-05: fewer than 200 changed lines in the merged pull requests, a flag) and complete the
 * project through the wizard. The block rules AF-01, AF-02, AF-04, AF-09 and AF-10 stay satisfied (ten
 * contributions from two accounts, stages in order and not faster than 24 hours, a fresh release link),
 * so the completion is allowed and the fraud check of the phase `completion` freezes the credit.
 *
 * Not exported by support/slice6-steps.ts (existing files are not touched): the closing of the stages, the
 * release checks and the press of "Завершить"; they are repeated here for the second team, with a release
 * address of its own (AF-02: the address is unique among the credited projects).
 */

export { CHECKS_TEST_TIMEOUT_MS };

const SECOND_RELEASE_URL = process.env.E2E_SECOND_RELEASE_URL ?? 'https://www.mozilla.org/';
/** The wait for the link-checker of the e2e stack (one domain once a minute, SEC-05). */
const CHECKS_WAIT_MS = 150_000;
const REVIEW_ANSWERS = [1, 2, 3].map((ordinal) => ({ ordinal, answer: true }));
/** 4 added and 1 deleted line in each of the four pull requests: 20 changed lines, far below the 200 of AF-05. */
const TINY = { additions: 4, deletions: 1 };

interface FeedBody {
  items: { title: string }[];
}

type Twin = Awaited<ReturnType<typeof double>>['app'];

export async function secondProjectStarts(): Promise<void> {
  routeWorld.teamName = `Команда среза 7 ${Date.now()}`;
  await slice5steps.teamOfThreeStartsTheProject();
  world.secondTeamId = routeWorld.teamId;
  world.secondTeamName = routeWorld.teamName;
  expect(world.secondTeamId).not.toBe(world.firstTeamId);
}

// ---- the work: six closed issues and four tiny merged pull requests ------------------------------------

async function closedIssue(app: Twin, repoId: number, author: GithubIdentityRef, title: string) {
  const item = app.openIssue(repoId, { author, assignees: [author], title });
  expect(await deliver(app.issuesEvent('opened', item))).toBe(202);
  app.closeIssue(repoId, item.number);
  expect(await deliver(app.issuesEvent('closed', item))).toBe(202);
}

async function tinyMergedPull(app: Twin, repoId: number, author: GithubIdentityRef, title: string) {
  const item = app.openPull(repoId, { author, title, ...TINY });
  expect(await deliver(app.pullRequestEvent('opened', item))).toBe(202);
  app.mergePull(repoId, item.number);
  expect(await deliver(app.pullRequestEvent('closed', item))).toBe(202);
}

export async function tinyPullRequestsAreDelivered(): Promise<void> {
  const app = (await double()).app;
  const [b, c] = await Promise.all([githubOf(person('b')), githubOf(person('c'))]);
  const repoId = githubWorld.repo.id;
  expect(repoId).toBeGreaterThan(0);
  const titles: string[] = [];
  for (const n of [1, 2, 3]) {
    titles.push(`Задача B ${n}`, `Задача C ${n}`);
    await closedIssue(app, repoId, b, `Задача B ${n}`);
    await closedIssue(app, repoId, c, `Задача C ${n}`);
  }
  for (const [author, label] of [
    [b, 'B'],
    [c, 'C'],
    [c, 'C2'],
    [c, 'C3'],
  ] as const) {
    titles.push(`Мелкая правка ${label}`);
    await tinyMergedPull(app, repoId, author, `Мелкая правка ${label}`);
  }
  await expect
    .poll(
      async () => {
        const feed = await get<FeedBody>(
          person('a'),
          `/v1/teams/${world.secondTeamId}/feed?limit=100`,
        );
        return feed.body.items.filter((i) => titles.includes(i.title)).length;
      },
      { timeout: 60_000, intervals: [500, 1_000, 2_000] },
    )
    .toBe(titles.length);
}

// ---- the stages of the mini playbook, closed through the API (slice 5 is tested elsewhere) ------------

async function upload(who: Person, itemId: string, name: string): Promise<void> {
  const response = await who.session.context.request.post(
    `/api/v1/teams/${world.secondTeamId}/checklist-items/${itemId}/files`,
    {
      multipart: { file: artifactFile(name) },
      headers: { ...ORIGIN_HEADERS, 'Idempotency-Key': randomUUID() },
    },
  );
  expect(response.status(), await response.text()).toBe(201);
}

async function doneWith(who: Person, stepKey: string, ordinal: number, body = {}): Promise<void> {
  const item = await itemOf(who, stepKey, ordinal);
  await patchItem(who, item, { status: 'done', ...body });
}

/** The 24 hours of C-08 are skipped, then the lead presses "Перейти". */
async function moveOn(ordinal: number): Promise<void> {
  backdateStage(world.secondTeamId, ordinal);
  const moved = await post(person('a'), `/v1/teams/${world.secondTeamId}/stage-transitions`, {
    fromOrdinal: ordinal,
  });
  expect(moved.status, moved.text).toBe(201);
}

async function closeStageOne(): Promise<void> {
  const [a, b, c] = [person('a'), person('b'), person('c')];
  const today = new Date().toISOString().slice(0, 10);
  const kickoff = {
    heldOn: today,
    outcome: 'Договорились о цели, ролях и правилах работы команды.',
  };
  await doneWith(b, 'mini_kickoff', 1, { ...kickoff, externalUrl: 'https://meet.example.org/k2' });
  const board = await itemOf(c, 'mini_board', 1);
  await patchItem(c, board, { linkUrl: 'https://example.org/' });
  await doneWith(c, 'mini_board', 1);
  const charter = await itemOf(a, 'mini_charter', 1);
  const path = `/v1/teams/${world.secondTeamId}/checklist-items/${charter.id}/assignee`;
  const assigned = await put(a, path, { version: charter.version, userId: c.id });
  expect(assigned.status, assigned.text).toBe(200);
  await upload(c, charter.id, 'charter.pdf');
  await doneWith(c, 'mini_charter', 1);
  const spec = await itemOf(b, 'mini_spec', 1);
  await upload(b, spec.id, 'spec.pdf');
  await doneWith(b, 'mini_spec', 1);
  const reviewed = await itemOf(c, 'mini_spec', 1);
  const reviewPath = `/v1/teams/${world.secondTeamId}/checklist-items/${reviewed.id}/review`;
  const review = await put(c, reviewPath, { version: reviewed.version, answers: REVIEW_ANSWERS });
  expect(review.status, review.text).toBe(200);
  await moveOn(1);
}

async function closeStageTwo(): Promise<void> {
  const [a, b, c] = [person('a'), person('b'), person('c')];
  const design = await itemOf(c, 'mini_design', 2);
  await upload(c, design.id, 'design.pdf');
  await doneWith(c, 'mini_design', 2);
  await doneWith(b, 'mini_retro', 2, {
    heldOn: new Date().toISOString().slice(0, 10),
    externalUrl: 'https://meet.example.org/r2',
    outcome: 'Что получилось, что нет и что меняем на следующем этапе.',
  });
  await moveOn(2);
  expect((await stages(a)).map((s) => s.status)).toEqual(['closed', 'closed', 'open']);
}

// ---- the release stage and "Завершить" ---------------------------------------------------------------------

async function checksAreGreen(): Promise<void> {
  const { page } = person('a').session;
  await page.goto(SLICE6_ROUTES.complete(world.secondTeamId));
  await completeUi.runChecks(page).click();
  for (const check of [/репозиторий/i, /релиз/i]) {
    await expect(completeUi.check(page, check)).toContainText(completeUi.passed, {
      timeout: CHECKS_WAIT_MS,
    });
  }
  await expect(completeUi.finish(page)).toBeEnabled();
}

async function releaseIsLinkedAndChecked(): Promise<void> {
  const a = person('a');
  const { page } = a.session;
  await page.goto(SLICE6_ROUTES.complete(world.secondTeamId));
  await completeUi.releaseLink(page).fill(SECOND_RELEASE_URL);
  await completeUi.saveRelease(page).click();
  await expect
    .poll(async () => (await itemOf(a, 'mini_final_links', 3)).linkUrl, { timeout: 30_000 })
    .toBe(SECOND_RELEASE_URL);
  const finalLinks = await itemOf(a, 'mini_final_links', 3);
  if (finalLinks.status !== 'done') await patchItem(a, finalLinks, { status: 'done' });
  await completeUi.runChecks(page).click();
  await expect(completeUi.checks(page)).toBeVisible({ timeout: CHECKS_WAIT_MS });
  // the second check of the release is not earlier than 24 hours after the first (FR-WORK-14)
  backdateStage(world.secondTeamId, 3);
  makeProjectOlder(world.secondTeamId);
  ageReleaseChecks(world.secondTeamId);
  await checksAreGreen();
}

export async function secondProjectIsCompleted(): Promise<void> {
  await closeStageOne();
  await closeStageTwo();
  await releaseIsLinkedAndChecked();
  const a = person('a');
  const closing = await post(a, `/v1/teams/${world.secondTeamId}/stage-transitions`, {
    fromOrdinal: 3,
  });
  expect([201, 409], closing.text).toContain(closing.status);
  const { page } = a.session;
  await page.goto(SLICE6_ROUTES.complete(world.secondTeamId));
  await completeUi.runChecks(page).click();
  await expect(completeUi.finish(page)).toBeEnabled({ timeout: CHECKS_WAIT_MS });
  await completeUi.finish(page).click();
  await completeUi.finishConfirm(page).click();
  await expect(completeUi.resultsHeading(page)).toBeVisible({ timeout: 30_000 });
}
