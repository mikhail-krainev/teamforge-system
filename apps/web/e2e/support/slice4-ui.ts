import type { Locator, Page } from '@playwright/test';
import { escapeRegExp } from './slice2-ui';

/**
 * Routes, labels and accessible names that slice4.spec.ts relies on, in one place (role and label
 * locators with Russian regexes, no CSS classes). Routes are those of docs/plan.md S4-07, S4-08; the
 * texts are those of apps/web/src/i18n/ru/matching.json. When the UI copy changes, fix it here only.
 */
export const ROUTES = {
  search: '/search',
  demand: '/demand',
  profile: '/profile',
  team: (id: string): string => `/teams/${id}`,
  seat: (teamId: string, seatId: string): string => `/teams/${teamId}/seats/${seatId}`,
} as const;

/** Role names of the seeded catalog as the select shows them. */
export const ROLE = { backend: { code: 'backend', label: 'Backend-разработчик' } } as const;

export const searchUi = {
  heading: (p: Page): Locator => p.getByRole('heading', { level: 1, name: /очередь поиска/i }),
  addRole: (p: Page): Locator => p.getByLabel(/^добавить роль$/i),
  submit: (p: Page): Locator => p.getByRole('button', { name: /^встать в очередь$/i }),
  /** "Вы в очереди" - the status of an active application. */
  inQueue: (p: Page): Locator => p.getByText(/вы в очереди/i).first(),
  roles: (p: Page): Locator => p.getByRole('list', { name: /роли по приоритету/i }),
  save: (p: Page): Locator => p.getByRole('button', { name: /^сохранить изменения$/i }),
  cancelOpen: (p: Page): Locator => p.getByRole('button', { name: /^выйти из очереди$/i }),
  cancelConfirm: (p: Page): Locator => p.getByRole('button', { name: /^да, выйти из очереди$/i }),
};

export const recommendationsUi = {
  heading: (p: Page): Locator => p.getByRole('heading', { name: /^рекомендованные команды$/i }),
  list: (p: Page): Locator => p.getByRole('list', { name: /^рекомендованные команды$/i }),
  /** "Подать заявку: {team name}" */
  apply: (p: Page, teamName: string): Locator =>
    p.getByRole('button', {
      name: new RegExp(`^подать заявку:\\s*${escapeRegExp(teamName)}$`, 'i'),
    }),
  applied: (p: Page): Locator => p.getByText(/заявка отправлена/i),
};

export const demandUi = {
  heading: (p: Page): Locator => p.getByRole('heading', { level: 1, name: /спрос на роли/i }),
  table: (p: Page): Locator => p.getByRole('table', { name: /спрос и очередь по ролям/i }),
  row: (p: Page, roleLabel: string): Locator =>
    demandUi.table(p).getByRole('row').filter({ hasText: roleLabel }),
  /** Columns in the order of the header: role, open seats, teams seeking, queued, wait, deficit. */
  column: { openSeats: 1, teamsSeeking: 2, queued: 3 } as const,
};

export const profileDemandUi = {
  block: (p: Page): Locator => p.getByRole('heading', { name: /спрос на ваши роли/i }),
};

export const candidatesUi = {
  list: (p: Page): Locator => p.getByRole('list', { name: /рекомендованные кандидаты/i }),
  /** "Предложить: {name}" */
  offer: (p: Page, name: string): Locator =>
    p.getByRole('button', { name: new RegExp(`^предложить:\\s*${escapeRegExp(name)}$`, 'i') }),
  offered: (p: Page): Locator => p.getByText(/предложение отправлено/i),
};

export const trialUi = {
  badge: (p: Page): Locator => p.getByText(/испытательный срок до/i),
  confirm: (p: Page, name: string): Locator =>
    p.getByRole('button', {
      name: new RegExp(`^подтвердить участника\\s+${escapeRegExp(name)}$`, 'i'),
    }),
  exclude: (p: Page, name: string): Locator =>
    p.getByRole('button', {
      name: new RegExp(`^исключить участника\\s+${escapeRegExp(name)}$`, 'i'),
    }),
  excludeYes: (p: Page): Locator => p.getByRole('button', { name: /^да, исключить$/i }),
  excluded: (p: Page): Locator => p.getByText(/участник исключён/i),
};

export const bellUi = {
  button: (p: Page): Locator => p.getByRole('button', { name: /уведомления/i }),
  unreadBadge: (p: Page): Locator => p.getByRole('status', { name: /непрочитанных/i }),
  item: (p: Page, text: RegExp): Locator => p.getByRole('menuitem').filter({ hasText: text }),
};
