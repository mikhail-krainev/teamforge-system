import { randomUUID } from 'node:crypto';
import { expect } from '@playwright/test';
import { ORIGIN_HEADERS } from './api';
import { expectNoSeriousA11yViolations } from './axe';
import { teamPageUi, ROUTES as TEAM_ROUTES } from './slice3-ui';
import {
  artifactFile,
  backdateStage,
  checklist,
  get,
  itemOf,
  makeAdmin,
  miniPlaybookText,
  patchItem,
  person,
  post,
  put,
  stages,
  uploadPlaybookText,
  world,
} from './slice5-world';
import {
  conflictUi,
  fileUi,
  linkRejectedUi,
  reviewUi,
  ROUTES,
  routeUi,
  stageUi,
  transitionUi,
} from './slice5-ui';

/**
 * Step bodies of slice5.spec.ts (docs/plan.md, "Тесты среза" -> Playwright slice5.spec.ts, steps 1-9),
 * written before the implementation (S5-01): they must fail until slice 5 is done.
 *
 * Not driven through a test-only door: the playbook goes in over the administrator API (step 1), the team is
 * built with the public operations (step 2), the 24 hours of C-08 are skipped by moving the opening of
 * the stage back in the throwaway e2e database (support/slice5-world.ts: backdateStage). The link check of
 * step 4 runs in the link-checker container of the e2e stack; without internet it ends `broken`, which
 * is still a finished check (the test accepts `ok` and `broken`).
 */

const TITLES = {
  kickoff: 'Kickoff команды',
  board: 'Репозиторий и доска',
  charter: 'Устав команды',
  spec: 'Спецификация',
  design: 'Дизайн интерфейса',
  retro: 'Ретроспектива этапа',
  notes: 'Дополнительные материалы',
} as const;

const REVIEW_POINTS = ['Записаны цели и не-цели?', 'Описаны альтернативы?', 'Указаны риски?'];

// ---- step 1: the administrator uploads and publishes the playbook --------------------------------

export async function adminPublishesThePlaybook(): Promise<void> {
  const admin = person('admin');
  makeAdmin(admin.id);
  const uploaded = await uploadPlaybookText(admin, miniPlaybookText());
  expect(uploaded.status, uploaded.text).toBe(201);
  expect(uploaded.body.playbook.status).toBe('draft');
  world.playbookId = uploaded.body.playbook.id;
  const published = await post<{ status: string }>(
    admin,
    `/v1/admin/playbooks/${world.playbookId}/publication`,
  );
  expect(published.status, published.text).toBe(200);
  expect(published.body.status).toBe('published');
  const listed = await get<{ items: { id: string }[] }>(
    person('a'),
    '/v1/playbooks?productType=web_service&limit=100',
  );
  expect(listed.status, listed.text).toBe(200);
  expect(listed.body.items.map((p) => p.id)).toContain(world.playbookId);
}

async function joinThroughOffers(seats: { id: string; roleCode: string }[]): Promise<void> {
  const [a, b, c] = [person('a'), person('b'), person('c')];
  for (const [who, role] of [
    [b, 'backend'],
    [c, 'frontend'],
  ] as const) {
    const seat = seats.find((s) => s.roleCode === role);
    expect(seat, role).toBeDefined();
    const offer = await post<{ id: string }>(a, `/v1/teams/${world.teamId}/seat-offers`, {
      seatId: seat?.id,
      userId: who.id,
    });
    expect(offer.status, offer.text).toBe(201);
    const accepted = await post(who, `/v1/seat-offers/${offer.body.id}/acceptance`);
    expect(accepted.status, accepted.text).toBe(200);
  }
}

// ---- step 2: a team of three starts the project --------------------------------------------------

export async function teamOfThreeStartsTheProject(): Promise<void> {
  const a = person('a');
  const created = await post<{
    id: string;
    seats: { id: string; roleCode: string }[];
    playbookId: string;
  }>(a, '/v1/teams', {
    name: world.teamName,
    description: 'Команда для сквозного сценария среза 5',
    timezone: 'Europe/Moscow',
    hoursPerWeek: 10,
    productTypeCode: 'web_service',
    seats: [
      { roleCode: 'backend', desired: false, minLevel: 'junior', minHours: 3, stack: [], count: 1 },
      {
        roleCode: 'frontend',
        desired: false,
        minLevel: 'junior',
        minHours: 3,
        stack: [],
        count: 1,
      },
    ],
  });
  expect(created.status, created.text).toBe(201);
  expect(created.body.playbookId, 'the team is pinned to the playbook of step 1').toBe(
    world.playbookId,
  );
  world.teamId = created.body.id;
  await joinThroughOffers(created.body.seats);

  const { page } = a.session;
  await page.goto(TEAM_ROUTES.team(world.teamId));
  await teamPageUi.start(page).click();
  await teamPageUi.startConfirm(page).click();
  await expect(teamPageUi.status(page)).toContainText(teamPageUi.statusText.active, {
    timeout: 30_000,
  });
  expect((await stages(a)).map((s) => s.status)).toEqual(['open', 'pending', 'pending']);
}

// ---- step 3: the route and the first stage -------------------------------------------------------

export async function routeShowsStageOneAndItsItems(): Promise<void> {
  const { page } = person('b').session;
  await page.goto(ROUTES.route(world.teamId));
  await expect(routeUi.heading(page)).toBeVisible();
  await expect(routeUi.timeline(page).getByRole('listitem')).toHaveCount(3);
  await expect(routeUi.currentStage(page)).toContainText(/этап\s*1/i);
  await expect(routeUi.due(page)).toBeVisible();
  await expectNoSeriousA11yViolations(page);

  await page.goto(ROUTES.stage(world.teamId, 1));
  await expect(stageUi.heading(page, 1)).toBeVisible();
  for (const title of [TITLES.kickoff, TITLES.board, TITLES.charter, TITLES.spec]) {
    await expect(stageUi.item(page, title)).toBeVisible();
  }
  // the charter has no pm/ba in the team: the fallback step is shown
  await expect(stageUi.fallbackAdvice(stageUi.item(page, TITLES.charter))).toBeVisible();
  // Backend holds the specification: he is its executor
  await expect(stageUi.assignee(stageUi.item(page, TITLES.spec))).toContainText(person('b').name);
  await expectNoSeriousA11yViolations(page);
}

// ---- step 4: a file, a link (checked), an item done ---------------------------------------------

export async function bUploadsAFileCPastesALinkAndCloseItems(): Promise<void> {
  const [b, c] = [person('b'), person('c')];
  const bPage = b.session.page;
  await bPage.goto(ROUTES.stage(world.teamId, 1));
  const spec = stageUi.item(bPage, TITLES.spec);
  const file = artifactFile('spec.pdf');
  await fileUi.input(spec).setInputFiles(file);
  await expect(fileUi.uploaded(spec, 'spec.pdf')).toBeVisible({ timeout: 30_000 });
  await expect(fileUi.download(spec, 'spec.pdf')).toBeVisible();
  await stageUi.status(spec).check();
  await expect(stageUi.status(spec)).toBeChecked();
  expect((await itemOf(b, 'mini_spec')).status).toBe('done');

  const cPage = c.session.page;
  await cPage.goto(ROUTES.stage(world.teamId, 1));
  const board = stageUi.item(cPage, TITLES.board);
  await stageUi.link(board).fill('https://example.org/team-board');
  await stageUi.saveLink(board).click();
  // the double of the checker finishes the check: `unchecked` becomes `ok` or `broken`, announced in a live region
  await expect
    .poll(async () => (await itemOf(c, 'mini_board')).linkStatus, {
      timeout: 90_000,
      intervals: [1_000, 2_000, 5_000],
    })
    .toMatch(/^(ok|broken)$/);
  await expect(stageUi.linkStatus(board)).toBeVisible();
  await stageUi.status(board).check();
  await expect(stageUi.status(board)).toBeChecked();
  await expectNoSeriousA11yViolations(cPage);
}

// ---- step 5: two people edit one item at once ----------------------------------------------------

export async function twoPeopleEditOneItemAndTheSecondSeesTheConflict(): Promise<void> {
  const [b, c] = [person('b'), person('c')];
  await b.session.page.goto(ROUTES.stage(world.teamId, 1));
  await c.session.page.goto(ROUTES.stage(world.teamId, 1));
  const bItem = stageUi.item(b.session.page, TITLES.kickoff);
  const cItem = stageUi.item(c.session.page, TITLES.kickoff);
  await expect(bItem).toBeVisible();
  await expect(cItem).toBeVisible();

  await stageUi.outcome(bItem).fill('Итоги Бориса: договорились о цели и ролях команды.');
  await stageUi.save(bItem).click();
  await expect
    .poll(async () => (await itemOf(b, 'mini_kickoff')).outcome)
    .toBe('Итоги Бориса: договорились о цели и ролях команды.');

  await stageUi.outcome(cItem).fill('Итоги Кирилла: договорились о правилах и ритме встреч.');
  await stageUi.save(cItem).click();
  await expect(conflictUi.alert(cItem)).toBeVisible();
  await expect(
    conflictUi.actualValue(cItem, 'Итоги Бориса: договорились о цели и ролях команды.'),
  ).toBeVisible();
  await expectNoSeriousA11yViolations(c.session.page);

  await conflictUi.reapply(cItem).click();
  await expect(conflictUi.alert(cItem)).toBeHidden();
  await expect
    .poll(async () => (await itemOf(c, 'mini_kickoff')).outcome)
    .toBe('Итоги Кирилла: договорились о правилах и ритме встреч.');
}

// ---- step 6: the review checklist and a risk accepted by the lead -------------------------------

export async function reviewWithOneNoAndTheLeadAcceptsTheRisk(): Promise<void> {
  const [a, c] = [person('a'), person('c')];
  const cPage = c.session.page;
  await cPage.goto(ROUTES.stage(world.teamId, 1));
  const spec = stageUi.item(cPage, TITLES.spec);
  await reviewUi.open(spec).click();
  const form = reviewUi.form(cPage);
  await reviewUi.answer(form, REVIEW_POINTS[0] ?? '', 'да').check();
  await reviewUi.answer(form, REVIEW_POINTS[1] ?? '', 'нет').check();
  await reviewUi.answer(form, REVIEW_POINTS[2] ?? '', 'да').check();
  await expectNoSeriousA11yViolations(cPage);
  await reviewUi.submit(form).click();
  await expect(reviewUi.notPassed(spec)).toBeVisible();
  const reviewed = await itemOf(c, 'mini_spec');
  expect(reviewed.review?.passed).toBe(false);
  expect(reviewed.review?.answers.map((x) => x.answer)).toEqual([true, false, true]);

  const aPage = a.session.page;
  await aPage.goto(ROUTES.stage(world.teamId, 1));
  const aSpec = stageUi.item(aPage, TITLES.spec);
  await reviewUi.acceptRisk(aSpec).click();
  await reviewUi.reason(aPage).fill('Альтернативы опишем на втором этапе, риск понятен.');
  await reviewUi.acceptConfirm(aPage).click();
  await expect(reviewUi.riskAccepted(aSpec)).toBeVisible();
  await expect(reviewUi.passed(aSpec)).toBeVisible();
  expect((await itemOf(a, 'mini_spec')).review?.passed).toBe(true);
}

/** The rest of stage 1 through the API: the charter goes to Frontend, the ritual gets its fields. */
async function fulfilTheRestOfStageOne(): Promise<void> {
  const [a, b, c] = [person('a'), person('b'), person('c')];
  const charter = await itemOf(a, 'mini_charter');
  const assigned = await put(
    a,
    `/v1/teams/${world.teamId}/checklist-items/${charter.id}/assignee`,
    { version: charter.version, userId: c.id },
  );
  expect(assigned.status, assigned.text).toBe(200);
  const upload = await c.session.context.request.post(
    `/api/v1/teams/${world.teamId}/checklist-items/${charter.id}/files`,
    {
      multipart: { file: artifactFile('charter.pdf') },
      headers: { ...ORIGIN_HEADERS, 'Idempotency-Key': randomUUID() },
    },
  );
  expect(upload.status(), await upload.text()).toBe(201);
  await patchItem(c, await itemOf(c, 'mini_charter'), { status: 'done' });
  const kickoff = await itemOf(b, 'mini_kickoff');
  await patchItem(b, kickoff, {
    status: 'done',
    heldOn: new Date().toISOString().slice(0, 10),
    externalUrl: 'https://meet.example.org/kickoff',
    outcome: 'Итоги Кирилла: договорились о правилах и ритме встреч.',
  });
  expect(
    (await checklist(a, 1))
      .filter((i) => i.stepKey !== 'mini_optional')
      .every((i) => i.status === 'done'),
  ).toBe(true);
}

// ---- step 7: "Перейти" before and after the conditions -------------------------------------------

export async function transitionIsBlockedThenSucceeds(): Promise<void> {
  const a = person('a');
  const aPage = a.session.page;
  // a second tab of the lead, opened now, becomes stale once the first tab moves the stage
  const staleTab = await a.session.context.newPage();
  await staleTab.goto(ROUTES.stage(world.teamId, 1));

  await aPage.goto(ROUTES.stage(world.teamId, 1));
  await transitionUi.button(aPage).click();
  await expect(transitionUi.unmetList(aPage)).toBeVisible();
  await expect(transitionUi.unmetItem(aPage, /обязательн/i)).toBeVisible();
  await expect(transitionUi.unmetItem(aPage, /исполнител|запасн/i)).toBeVisible();
  await expect(transitionUi.unmetItem(aPage, /24 час|минимальн/i)).toBeVisible();
  await expectNoSeriousA11yViolations(aPage);
  expect((await stages(a)).map((s) => s.status)).toEqual(['open', 'pending', 'pending']);

  await fulfilTheRestOfStageOne();
  backdateStage(world.teamId, 1);

  await aPage.reload();
  await transitionUi.button(aPage).click();
  await transitionUi.confirm(aPage).click();
  await expect(transitionUi.moved(aPage)).toBeVisible({ timeout: 30_000 });
  expect((await stages(a)).map((s) => s.status)).toEqual(['closed', 'open', 'pending']);
  await aPage.goto(ROUTES.route(world.teamId));
  await expect(routeUi.currentStage(aPage)).toContainText(/этап\s*2/i);
  await expectNoSeriousA11yViolations(aPage);

  // the stale tab still shows stage 1 as open: the lead clicks again and learns that it is closed (409 STAGE_NOT_OPEN)
  await transitionUi.button(staleTab).click();
  await transitionUi
    .confirm(staleTab)
    .click()
    .catch(() => undefined);
  await expect(transitionUi.notOpen(staleTab)).toBeVisible();
  expect((await stages(a)).filter((s) => s.status === 'open')).toHaveLength(1);
  await staleTab.close();
}

// ---- step 8: a link to an internal address is refused --------------------------------------------

export async function internalLinkIsRefusedWithAClearMessage(): Promise<void> {
  const c = person('c');
  const { page } = c.session;
  await page.goto(ROUTES.stage(world.teamId, 2));
  const notes = stageUi.item(page, TITLES.notes);
  for (const link of ['http://127.0.0.1', 'https://169.254.169.254/latest/meta-data/']) {
    await stageUi.link(notes).fill(link);
    await stageUi.saveLink(notes).click();
    await expect(linkRejectedUi.alert(page)).toBeVisible();
    await expectNoSeriousA11yViolations(page);
  }
  const stored = await itemOf(c, 'mini_notes', 2);
  expect(stored.linkUrl ?? null).toBeNull();
  expect(stored.linkStatus).toBe('none');
}

// ---- step 9: every page of the slice is accessible ----------------------------------------------

export async function everyPageOfTheSliceIsAccessible(): Promise<void> {
  const { page } = person('b').session;
  for (const url of [
    ROUTES.route(world.teamId),
    ROUTES.stage(world.teamId, 1),
    ROUTES.stage(world.teamId, 2),
  ]) {
    await page.goto(url);
    await expect(page.getByRole('main')).toBeVisible();
    await expectNoSeriousA11yViolations(page);
  }
}
