import type { Locator, Page } from '@playwright/test';
import { escapeRegExp } from './slice2-ui';

/**
 * Routes, labels and accessible names that slice6.spec.ts relies on, in one place (role and label
 * locators with Russian regexes, no CSS classes). The routes are those of docs/plan.md S6-09..S6-11
 * (`/teams/[id]/github`, `/teams/[id]/feed`, `/teams/[id]/complete`); the texts are the expected contents of
 * apps/web/src/i18n/ru/{github,feed,completion}.json (an assumption: the frontend tasks adapt the copy or
 * tell the test author which regex to loosen). When the UI copy changes, fix it here only.
 */
export const ROUTES = {
  github: (teamId: string): string => `/teams/${teamId}/github`,
  feed: (teamId: string): string => `/teams/${teamId}/feed`,
  complete: (teamId: string): string => `/teams/${teamId}/complete`,
  /** The page the browser returns to after GitHub (plan S6-09: `app/github/setup`). */
  setupReturn: '/github/setup',
} as const;

/** `/teams/[id]/github` (S6-09). */
export const githubUi = {
  heading: (p: Page): Locator =>
    p.getByRole('heading', { level: 1, name: /подключение github|репозиторий проекта/i }),
  /** FR-GH-11: the hint for the lead. */
  projectsHint: (p: Page): Locator => p.getByText(/ведите задачи как issues/i),
  install: (p: Page): Locator => p.getByRole('button', { name: /установить app/i }),
  installed: (p: Page): Locator =>
    p.getByRole('status').filter({ hasText: /app установлен|установка подключена/i }),
  repositories: (p: Page): Locator =>
    p.getByRole('radiogroup', {
      name: /репозиторий(и|ев)? (для выбора|установки)|выберите репозиторий/i,
    }),
  repository: (p: Page, fullName: string): Locator =>
    githubUi.repositories(p).getByRole('radio', { name: new RegExp(escapeRegExp(fullName), 'i') }),
  link: (p: Page): Locator => p.getByRole('button', { name: /привязать репозиторий/i }),
  linked: (p: Page, fullName: string): Locator =>
    p
      .getByRole('status')
      .filter({ hasText: /репозиторий привязан/i })
      .filter({ hasText: new RegExp(escapeRegExp(fullName), 'i') }),
  unlink: (p: Page): Locator => p.getByRole('button', { name: /отвязать репозиторий/i }),
  /** 409 REPO_TAKEN. */
  taken: (p: Page): Locator =>
    p.getByRole('alert').filter({ hasText: /уже привязан к другой команде|репозиторий занят/i }),
};

/** `/teams/[id]/feed` (S6-10). */
export const feedUi = {
  heading: (p: Page): Locator =>
    p.getByRole('heading', { level: 1, name: /лента (задач|проекта)|лента и вклад/i }),
  list: (p: Page): Locator => p.getByRole('list', { name: /лента задач/i }),
  entry: (p: Page, title: string): Locator =>
    feedUi.list(p).getByRole('listitem').filter({ hasText: title }),
  entries: (p: Page): Locator => feedUi.list(p).getByRole('listitem'),
  /** Filters. */
  executor: (p: Page): Locator => p.getByLabel(/^исполнитель/i),
  source: (p: Page): Locator => p.getByLabel(/^источник/i),
  more: (p: Page): Locator => p.getByRole('button', { name: /показать ещё|загрузить ещё/i }),
  /** The summary of contributions by member and role. */
  summary: (p: Page): Locator => p.getByRole('region', { name: /вклад участников/i }),
  /** Relabelling the role of a contribution (FR-WORK-17), with a confirmation. */
  relabel: (entry: Locator): Locator => entry.getByRole('button', { name: /сменить роль/i }),
  newRole: (p: Page): Locator => p.getByLabel(/новая роль/i),
  relabelConfirm: (p: Page): Locator => p.getByRole('button', { name: /^подтвердить$/i }),
};

/** `/teams/[id]/complete` (S6-11): the wizard and the results screen. */
export const completeUi = {
  heading: (p: Page): Locator => p.getByRole('heading', { level: 1, name: /завершение проекта/i }),
  releaseLink: (p: Page): Locator => p.getByLabel(/ссылка на релиз/i),
  saveRelease: (p: Page): Locator => p.getByRole('button', { name: /сохранить ссылку/i }),
  runChecks: (p: Page): Locator => p.getByRole('button', { name: /запустить проверки/i }),
  checks: (p: Page): Locator => p.getByRole('list', { name: /проверки готовности/i }),
  check: (p: Page, title: RegExp): Locator =>
    completeUi.checks(p).getByRole('listitem').filter({ hasText: title }),
  passed: /пройдена|выполнена|\bок\b/i,
  failed: /не пройдена|не выполнена|ошибка/i,
  /** "Вторая проверка релиза возможна через ..." */
  secondCheckTimer: (p: Page): Locator => p.getByText(/вторая проверка релиза/i),
  finish: (p: Page): Locator => p.getByRole('button', { name: /^завершить проект$/i }),
  finishConfirm: (p: Page): Locator => p.getByRole('button', { name: /^да, завершить$/i }),
  /** The results screen (getCompletion). */
  resultsHeading: (p: Page): Locator =>
    p.getByRole('heading', { level: 1, name: /проект завершён|итоги проекта/i }),
  overdue: (p: Page): Locator => p.getByText(/без просрочки|просрочка\s+\d+\s*дн/i),
  composition: (p: Page): Locator => p.getByRole('region', { name: /состав команды/i }),
  contributions: (p: Page): Locator => p.getByRole('region', { name: /вклад по ролям/i }),
};
