import type { Locator, Page } from '@playwright/test';
import { escapeRegExp } from './slice2-ui';

/**
 * Routes, labels and accessible names that slice5.spec.ts relies on, in one place (role and label
 * locators with Russian regexes, no CSS classes). The routes are those of docs/plan.md S5-10; the texts
 * are the expected contents of apps/web/src/i18n/ru/route.json (an assumption: the frontend task adapts
 * the copy or tells the test author which regex to loosen). When the UI copy changes, fix it here only.
 */
export const ROUTES = {
  route: (teamId: string): string => `/teams/${teamId}/route`,
  stage: (teamId: string, ordinal: number): string => `/teams/${teamId}/stages/${ordinal}`,
  team: (teamId: string): string => `/teams/${teamId}`,
} as const;

export const routeUi = {
  heading: (p: Page): Locator => p.getByRole('heading', { level: 1, name: /маршрут проекта/i }),
  timeline: (p: Page): Locator => p.getByRole('list', { name: /этапы проекта/i }),
  stage: (p: Page, ordinal: number): Locator =>
    routeUi
      .timeline(p)
      .getByRole('listitem')
      .filter({ hasText: new RegExp(`этап\\s*${ordinal}\\b`, 'i') }),
  currentStage: (p: Page): Locator => p.locator('li[aria-current="step"]'),
  due: (p: Page): Locator => p.getByText(/срок до|плановая дата/i).first(),
  openStage: (p: Page, ordinal: number): Locator =>
    p
      .getByRole('link', {
        name: new RegExp(`перейти к этапу\\s*${ordinal}\\b|этап\\s*${ordinal}\\b`, 'i'),
      })
      .first(),
};

export const stageUi = {
  heading: (p: Page, ordinal: number): Locator =>
    p.getByRole('heading', { level: 1, name: new RegExp(`этап\\s*${ordinal}\\b`, 'i') }),
  checklist: (p: Page): Locator => p.getByRole('list', { name: /чек-лист этапа/i }),
  item: (p: Page, title: string): Locator =>
    stageUi.checklist(p).getByRole('listitem').filter({ hasText: title }),
  /** Fields inside one item. */
  status: (item: Locator): Locator => item.getByRole('checkbox', { name: /выполнен/i }),
  assignee: (item: Locator): Locator => item.getByText(/исполнитель/i).first(),
  fallbackAdvice: (item: Locator): Locator => item.getByText(/запасной шаг/i).first(),
  link: (item: Locator): Locator => item.getByLabel(/^ссылка/i),
  saveLink: (item: Locator): Locator => item.getByRole('button', { name: /сохранить ссылку/i }),
  linkStatus: (item: Locator): Locator => item.getByRole('status', { name: /проверка ссылки/i }),
  /** Ritual fields. */
  heldOn: (item: Locator): Locator => item.getByLabel(/дата проведения/i),
  externalUrl: (item: Locator): Locator => item.getByLabel(/ссылка на созвон|внешняя ссылка/i),
  outcome: (item: Locator): Locator => item.getByLabel(/итоги/i),
  save: (item: Locator): Locator => item.getByRole('button', { name: /^сохранить$/i }),
  /** aria-live announcement of the auto checks. */
  checksLive: (p: Page): Locator => p.locator('[aria-live="polite"]').first(),
};

/** Version conflicts (S5-11): the actual value is shown and the user's changes can be applied again. */
export const conflictUi = {
  alert: (item: Locator): Locator =>
    item.getByRole('alert').filter({ hasText: /изменил(и|а)? (этот )?пункт|конфликт версий/i }),
  actualValue: (item: Locator, text: string): Locator => item.getByText(text),
  reapply: (item: Locator): Locator =>
    item.getByRole('button', { name: /применить мои изменения заново/i }),
};

/** Files (S5-12). */
export const fileUi = {
  input: (item: Locator): Locator => item.getByLabel(/загрузить файл/i),
  progress: (item: Locator): Locator => item.getByRole('progressbar'),
  uploaded: (item: Locator, name: string): Locator =>
    item.getByRole('listitem').filter({ hasText: name }),
  download: (item: Locator, name: string): Locator =>
    item.getByRole('link', { name: new RegExp(`скачать\\s+${escapeRegExp(name)}`, 'i') }),
  remove: (item: Locator, name: string): Locator =>
    item.getByRole('button', { name: new RegExp(`удалить файл\\s+${escapeRegExp(name)}`, 'i') }),
  error: (item: Locator): Locator => item.getByRole('alert'),
};

/** The review checklist (S5-12). */
export const reviewUi = {
  open: (item: Locator): Locator => item.getByRole('button', { name: /пройти ревью/i }),
  form: (p: Page): Locator => p.getByRole('group', { name: /чек-лист ревью/i }),
  answer: (form: Locator, pointText: string, answer: 'да' | 'нет'): Locator =>
    form
      .getByRole('group', { name: new RegExp(escapeRegExp(pointText), 'i') })
      .getByRole('radio', { name: new RegExp(`^${answer}$`, 'i') }),
  submit: (form: Locator): Locator => form.getByRole('button', { name: /отправить ревью/i }),
  passed: (item: Locator): Locator => item.getByText(/ревью пройдено/i),
  notPassed: (item: Locator): Locator => item.getByText(/ревью не пройдено/i),
  acceptRisk: (item: Locator): Locator => item.getByRole('button', { name: /принять как риск/i }),
  reason: (p: Page): Locator => p.getByLabel(/обоснование/i),
  acceptConfirm: (p: Page): Locator => p.getByRole('button', { name: /^принять риск$/i }),
  riskAccepted: (item: Locator): Locator => item.getByText(/риск принят/i),
};

/** The transition (S5-13). */
export const transitionUi = {
  button: (p: Page): Locator => p.getByRole('button', { name: /перейти к следующему этапу/i }),
  unmetList: (p: Page): Locator => p.getByRole('list', { name: /невыполненные условия/i }),
  unmetItem: (p: Page, text: RegExp): Locator =>
    transitionUi.unmetList(p).getByRole('listitem').filter({ hasText: text }),
  confirm: (p: Page): Locator => p.getByRole('button', { name: /^да, перейти$/i }),
  moved: (p: Page): Locator => p.getByText(/открыт этап\s*\d/i),
  notOpen: (p: Page): Locator =>
    p.getByRole('alert').filter({ hasText: /уже переведён|этап уже закрыт|другой участник/i }),
  confirmParticipation: (p: Page, name: string): Locator =>
    p.getByRole('button', {
      name: new RegExp(`подтвердить участие:?\\s*${escapeRegExp(name)}`, 'i'),
    }),
};

/** Messages for a refused link (S5-11). */
export const linkRejectedUi = {
  alert: (p: Page): Locator =>
    p
      .getByRole('alert')
      .filter({ hasText: /ссылка отклонена|нельзя использовать внутренний адрес|только https/i }),
};
