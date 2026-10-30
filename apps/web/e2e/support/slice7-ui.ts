import type { Locator, Page } from '@playwright/test';
import { escapeRegExp } from './slice2-ui';

/**
 * Routes, labels and accessible names that slice7.spec.ts relies on, in one place (role and label
 * locators with Russian regexes, no CSS classes). The routes are those of docs/plan.md S7-08..S7-10
 * (`/teams/[id]/credit`, `/users/[id]` and `/profile` with the awards block, `/reviews`, `/admin/fraud`);
 * the texts are the expected contents of apps/web/src/i18n/ru/{rewards,reviews,fraud}.json (an
 * assumption: the frontend tasks adapt the copy or tell the test author which regex to loosen). The
 * badge names are those of spec FR-REW-05. When the UI copy changes, fix it here only.
 */
export const ROUTES = {
  credit: (teamId: string): string => `/teams/${teamId}/credit`,
  user: (userId: string): string => `/users/${userId}`,
  ownProfile: '/profile',
  reviews: '/reviews',
  fraud: '/admin/fraud',
} as const;

/** Names of the badges of FR-REW-05 that the scenario meets. */
export const BADGES = {
  firstRelease: 'Первый релиз',
  onTime: 'В срок',
  /** `available = false` in the seeds (step 4 of the series "Типы продукта"): shown as unavailable. */
  collector: 'Коллекционер форматов',
} as const;

/** `/teams/[id]/credit` (S7-08): the result of the credit of the team, the complaint. */
export const creditUi = {
  heading: (p: Page): Locator =>
    p.getByRole('heading', { level: 1, name: /зачёт проекта|итоги зачёта/i }),
  /** The status of the credit run (`getTeamCredit.status`), an aria-live region. */
  status: (p: Page): Locator => p.getByRole('status', { name: /статус зачёта/i }),
  statusText: {
    cooling: /ждём 7 дней/i,
    /** Not "не зачтено": a denied credit must not satisfy a wait for the credited one. */
    credited: /(?<!не )зачтено/i,
    frozen: /заморожено|на ручной проверке/i,
    revoked: /отозван/i,
  },
  /** The countdown to the end of the cooling (an element with role "timer"; it carries a number). */
  countdown: (p: Page): Locator => p.getByRole('timer', { name: /осталось ждать/i }),
  /** The credits of the signed-in user by role (`myCredits`). */
  myCredits: (p: Page): Locator => p.getByRole('list', { name: /мой зачёт по ролям/i }),
  myCredit: (p: Page, role: RegExp): Locator =>
    creditUi.myCredits(p).getByRole('listitem').filter({ hasText: role }),
  /** Fraud rules are never shown to the participants ("без раскрытия чужих сигналов"). */
  leakedRuleCode: (p: Page): Locator => p.getByText(/\bAF-\d{2}\b/),
  /** FR-REW-11: the complaint during the cooling. */
  dispute: (p: Page): Locator => p.getByRole('button', { name: /оспорить проект/i }),
  disputeText: (p: Page): Locator => p.getByLabel(/причина жалобы|опишите причину/i),
  disputeSubmit: (p: Page): Locator => p.getByRole('button', { name: /отправить жалобу/i }),
  disputeSent: (p: Page): Locator =>
    p.getByRole('status').filter({ hasText: /жалоба отправлена|жалоба принята/i }),
};

/** The awards block of `/users/[id]` and `/profile` (S7-08, FR-PROF-06). */
export const awardsUi = {
  region: (p: Page): Locator => p.getByRole('region', { name: /награды/i }),
  badges: (p: Page): Locator =>
    awardsUi.region(p).getByRole('list', { name: /полученные значки/i }),
  badge: (p: Page, name: string): Locator =>
    awardsUi.badges(p).getByRole('listitem').filter({ hasText: name }),
  /** A step of a series is called "ступень", not "уровень" (FR-REW-05). */
  step: (n: number): RegExp => new RegExp(`ступень\\s*${n}\\b`, 'i'),
  counters: (p: Page): Locator => p.getByRole('region', { name: /счётчики/i }),
  /** "Зачтённых проектов: 1", "Backend: 1": the text of the counters block. */
  counterText: (label: string, value: number): RegExp =>
    new RegExp(`${escapeRegExp(label)}[:\\s]+${value}(?!\\d)`, 'i'),
  /** The catalog of badges with the states "получен" and "недоступен". */
  catalog: (p: Page): Locator => p.getByRole('region', { name: /каталог значков/i }),
  catalogItem: (p: Page, name: string): Locator =>
    awardsUi.catalog(p).getByRole('listitem').filter({ hasText: name }),
  unavailable: /недоступен/i,
};

/** `/reviews` (S7-09, FR-PROF-08): the form, the received list, the sent list. */
export const reviewsUi = {
  heading: (p: Page): Locator => p.getByRole('heading', { level: 1, name: /^отзывы/i }),
  /** The permanent hint above the form. */
  batchHint: (p: Page): Locator => p.getByText(/отзывы будут опубликованы пакетом/i),
  form: (p: Page): Locator => p.getByRole('form', { name: /новый отзыв|оставить отзыв/i }),
  /** Present only when the user has more than one finished project; the scenario selects it when it is there. */
  team: (p: Page): Locator => reviewsUi.form(p).getByLabel(/^проект/i),
  colleague: (p: Page): Locator => reviewsUi.form(p).getByLabel(/^кому/i),
  text: (p: Page): Locator => reviewsUi.form(p).getByLabel(/текст отзыва/i),
  submit: (p: Page): Locator => reviewsUi.form(p).getByRole('button', { name: /отправить отзыв/i }),
  /** The aria-live message after a send: the review is shown only if there are two or more of them. */
  notice: (p: Page): Locator =>
    p.getByRole('status').filter({ hasText: /отзывы будут опубликованы пакетом/i }),
  received: (p: Page): Locator =>
    p.getByRole('region', { name: /отзывы обо мне|полученные отзывы/i }),
  receivedItems: (p: Page): Locator => reviewsUi.received(p).getByRole('listitem'),
  receivedEmpty: (p: Page): Locator =>
    reviewsUi.received(p).getByText(/пока нет отзывов|отзывов нет|нет полученных отзывов/i),
  sent: (p: Page): Locator => p.getByRole('region', { name: /отправленные отзывы/i }),
  sentItems: (p: Page): Locator => reviewsUi.sent(p).getByRole('listitem'),
  /** "Опубликовано 04.11.2026": only the date of the batch, never a time. */
  published: /опубликован\S*\s+\d{2}\.\d{2}\.\d{4}/i,
  timeOfDay: /\d{1,2}:\d{2}/,
};

/** `/admin/fraud` (S7-10, FR-REW-16): the queue, the case card, the decision with a confirmation. */
export const fraudUi = {
  heading: (p: Page): Locator =>
    p.getByRole('heading', { level: 1, name: /ручная проверка|разбор подозрительных проектов/i }),
  cases: (p: Page): Locator => p.getByRole('list', { name: /дела на проверке|очередь проверки/i }),
  caseItem: (p: Page, teamName: string): Locator =>
    fraudUi.cases(p).getByRole('listitem').filter({ hasText: teamName }),
  openCase: (item: Locator): Locator => item.getByRole('link', { name: /открыть дело/i }),
  card: (p: Page): Locator => p.getByRole('region', { name: /карточка дела/i }),
  signals: (p: Page): Locator =>
    fraudUi.card(p).getByRole('list', { name: /сработавшие правила/i }),
  signal: (p: Page, ruleCode: string): Locator =>
    fraudUi.signals(p).getByRole('listitem').filter({ hasText: ruleCode }),
  disputes: (p: Page): Locator => fraudUi.card(p).getByRole('list', { name: /жалобы участников/i }),
  comment: (p: Page): Locator => fraudUi.card(p).getByLabel(/комментарий/i),
  decide: (p: Page, decision: 'ok' | 'violation'): Locator =>
    fraudUi.card(p).getByRole('button', {
      name: decision === 'ok' ? /^решение: в порядке$/i : /^решение: нарушение$/i,
    }),
  confirmDialog: (p: Page): Locator => p.getByRole('dialog', { name: /подтвердите решение/i }),
  confirm: (p: Page): Locator =>
    fraudUi.confirmDialog(p).getByRole('button', { name: /^подтвердить$/i }),
  decided: (p: Page): Locator =>
    fraudUi
      .card(p)
      .getByRole('status')
      .filter({ hasText: /решение принято/i }),
  verdict: { violation: /нарушение/i, ok: /в порядке/i },
};
