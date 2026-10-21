import { expect } from '@playwright/test';
import { expectNoSeriousA11yViolations } from './axe';
import { DISPLAY_NAMES, post } from './slice6-world';
import { reviewsUi, ROUTES } from './slice7-ui';
import {
  advanceCooling,
  countersOf,
  dateRu,
  get,
  person,
  REVIEW_TEXTS,
  world,
  type Person,
} from './slice7-world';

/**
 * Step 4 of slice7.spec.ts (FR-PROF-08, SEC-04): the reviews of colleagues. A writes to B and C, B writes
 * to C (so C has two authors and B only one). The recipient sees nothing while the window of C-27
 * (14 days) is open, and after it C sees both reviews (without the authors, with the date of the batch)
 * while B, who has only one author, sees nothing for ever. The window is closed by moving the database
 * (support/slice7-world.ts: advanceCooling). Written before S7-07 and S7-09: it must fail until they are done.
 */

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
/** Seven days more after the 8 of the credit step: 15 days after the completion, the window (14) is closed. */
const WINDOW_CLOSING_DAYS = 7;

interface ReceivedPage {
  items: { id: string; teamId: string; teamName: string; text: string; publishedOn: string }[];
  nextCursor: string | null;
}

interface SentList {
  items: { subjectUserId: string; status: string }[];
  windowClosesAt: string;
}

/** The right to review comes from the event of the completion (an asynchronous projection). */
async function waitForEligibility(who: Person): Promise<void> {
  await expect
    .poll(async () => (await get(who, `/v1/teams/${world.firstTeamId}/reviews/sent`)).status, {
      timeout: 60_000,
      intervals: [500, 1_000, 2_000],
    })
    .toBe(200);
}

async function leaveReview(who: Person, colleague: string, text: string): Promise<void> {
  const { page } = who.session;
  await page.goto(ROUTES.reviews);
  await expect(reviewsUi.heading(page)).toBeVisible();
  await expect(reviewsUi.batchHint(page)).toBeVisible();
  if ((await reviewsUi.team(page).count()) > 0) {
    await reviewsUi.team(page).selectOption({ label: world.firstTeamName });
  }
  await reviewsUi.colleague(page).selectOption({ label: colleague });
  await reviewsUi.text(page).fill(text);
  await reviewsUi.submit(page).click();
  // aria-live: the author is told that the reviews appear as a batch, and only if there are at least two
  await expect(reviewsUi.notice(page)).toBeVisible();
}

async function nothingIsReceived(who: Person): Promise<void> {
  const received = await get<ReceivedPage>(who, '/v1/me/reviews');
  expect(received.status, received.text).toBe(200);
  expect(received.body.items).toEqual([]);
  const { page } = who.session;
  await page.goto(ROUTES.reviews);
  await expect(reviewsUi.receivedEmpty(page)).toBeVisible();
  await expect(reviewsUi.receivedItems(page)).toHaveCount(0);
}

export async function reviewsAreWrittenAndStayHiddenInTheWindow(): Promise<void> {
  const [a, b, c] = [person('a'), person('b'), person('c')];
  for (const who of [a, b, c]) await waitForEligibility(who);

  await leaveReview(a, DISPLAY_NAMES.b, REVIEW_TEXTS.aToB);
  await expectNoSeriousA11yViolations(a.session.page);
  await leaveReview(a, DISPLAY_NAMES.c, REVIEW_TEXTS.aToC);
  await expect(reviewsUi.sentItems(a.session.page)).toHaveCount(2);
  // one author only: the recipients see nothing, no matter how long they wait
  await nothingIsReceived(b);
  await nothingIsReceived(c);

  await leaveReview(b, DISPLAY_NAMES.c, REVIEW_TEXTS.bToC);
  // two authors for C, but the batch comes only after the window has closed (no leak by time or order)
  await nothingIsReceived(c);
  await nothingIsReceived(b);
}

export async function refusedReviewsAreExplainedByTheApi(): Promise<void> {
  const [a, b, d] = [person('a'), person('b'), person('d')];
  const path = `/v1/teams/${world.firstTeamId}/reviews`;
  const text = 'Отзыв, который не должен быть принят.';
  const self = await post<{ code: string }>(a, path, { subjectUserId: a.id, text });
  expect(self.status, self.text).toBe(422);
  const again = await post<{ code: string }>(a, path, { subjectUserId: b.id, text });
  expect(again.status, again.text).toBe(409);
  expect(again.body.code).toBe('REVIEW_EXISTS');
  const tooLong = await post(a, path, { subjectUserId: b.id, text: 'я'.repeat(2001) });
  expect([400, 422], tooLong.text).toContain(tooLong.status);
  // IDOR: an outsider of the project cannot review a participant or read the sent list
  const outsider = await post(d, path, { subjectUserId: b.id, text });
  expect(outsider.status, outsider.text).toBe(404);
  expect((await get(d, `${path}/sent`)).status).toBe(404);
}

function expectAnonymousBatch(page: ReceivedPage, rawText: string): void {
  const [a, b] = [person('a'), person('b')];
  expect(page.items).toHaveLength(2);
  for (const item of page.items) {
    // the whole shape: no author, no time of creation (FR-PROF-08, SEC-04)
    expect(Object.keys(item).sort()).toEqual(['id', 'publishedOn', 'teamId', 'teamName', 'text']);
    expect(item.id).toMatch(UUID_V4);
  }
  expect(new Set(page.items.map((item) => item.publishedOn)).size).toBe(1);
  expect(page.items.map((item) => item.text).sort()).toEqual(
    [REVIEW_TEXTS.aToC, REVIEW_TEXTS.bToC].sort(),
  );
  for (const secret of [a.id, b.id, a.login, b.login, DISPLAY_NAMES.a, DISPLAY_NAMES.b]) {
    expect(rawText).not.toContain(secret);
  }
}

async function receivedPageShowsTheBatch(who: Person, date: string): Promise<void> {
  const { page } = who.session;
  await page.goto(ROUTES.reviews);
  await expect(reviewsUi.receivedItems(page)).toHaveCount(2);
  const region = reviewsUi.received(page);
  await expect(region).toContainText(REVIEW_TEXTS.aToC);
  await expect(region).toContainText(REVIEW_TEXTS.bToC);
  await expect(region).toContainText(dateRu(date));
  await expect(region).toContainText(reviewsUi.published);
  await expect(region).not.toContainText(reviewsUi.timeOfDay);
  await expect(region).not.toContainText(/Анна|Лидов|Борис|Бэкендов/);
  await expectNoSeriousA11yViolations(page);
}

export async function batchIsPublishedAfterTheWindowWithoutAuthors(): Promise<void> {
  const [a, b, c] = [person('a'), person('b'), person('c')];
  advanceCooling(world.firstTeamId, WINDOW_CLOSING_DAYS);

  const received = await get<ReceivedPage>(c, '/v1/me/reviews');
  expect(received.status, received.text).toBe(200);
  expectAnonymousBatch(received.body, received.text);
  const date = received.body.items[0]?.publishedOn ?? '';
  expect(date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  await receivedPageShowsTheBatch(c, date);

  // B has one author only (A): the batch is never published for him; A has none
  await nothingIsReceived(b);
  await nothingIsReceived(a);
  // the window is closed: a new review is refused
  const late = await post<{ code: string }>(c, `/v1/teams/${world.firstTeamId}/reviews`, {
    subjectUserId: a.id,
    text: 'Поздний отзыв после закрытия окна.',
  });
  expect(late.status, late.text).toBe(409);
  expect(late.body.code).toBe('REVIEW_WINDOW_CLOSED');
  // FR-REW-13: the reviews do not reach the rewards: the totals of the credit are what they were
  for (const who of [b, c]) expect((await countersOf(who, who.id)).total).toBe(1);
}

async function sentListOf(who: Person): Promise<SentList> {
  const sent = await get<SentList>(who, `/v1/teams/${world.firstTeamId}/reviews/sent`);
  expect(sent.status, sent.text).toBe(200);
  expect(sent.body.windowClosesAt).toBeTruthy();
  return sent.body;
}

export async function sentListShowsOnlyTheOwnReviews(): Promise<void> {
  const [a, b, c] = [person('a'), person('b'), person('c')];
  const ids = async (who: Person): Promise<string[]> =>
    (await sentListOf(who)).items.map((item) => item.subjectUserId).sort();
  expect(await ids(a)).toEqual([b.id, c.id].sort());
  expect(await ids(b)).toEqual([c.id]);
  expect(await ids(c)).toEqual([]);

  // the page: the colleague, never the text of what the others wrote
  await a.session.page.goto(ROUTES.reviews);
  await expect(reviewsUi.sentItems(a.session.page)).toHaveCount(2);
  await expect(reviewsUi.sent(a.session.page)).toContainText(DISPLAY_NAMES.b);
  await expect(reviewsUi.sent(a.session.page)).toContainText(DISPLAY_NAMES.c);
  await b.session.page.goto(ROUTES.reviews);
  await expect(reviewsUi.sentItems(b.session.page)).toHaveCount(1);
  await expect(reviewsUi.sent(b.session.page)).not.toContainText(DISPLAY_NAMES.b);
  await c.session.page.goto(ROUTES.reviews);
  await expect(reviewsUi.sentItems(c.session.page)).toHaveCount(0);
}
