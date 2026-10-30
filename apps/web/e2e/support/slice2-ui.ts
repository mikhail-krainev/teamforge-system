import type { Locator, Page } from '@playwright/test';

/**
 * Every route, label and accessible name that slice2.spec.ts relies on, in one place. Role and label
 * locators with Russian regexes only (no CSS classes); when the UI copy changes, fix it here.
 * The names follow apps/web/src/i18n/ru/{auth,profile}.json.
 */
export const ROUTES = {
  signIn: '/sign-in',
  confirm: '/auth/confirm',
  profile: '/profile',
  settings: '/settings',
  user: (id: string): string => `/users/${id}`,
} as const;

export const signInUi = {
  heading: (p: Page): Locator => p.getByRole('heading', { level: 1, name: /вход в корнер/i }),
  email: (p: Page): Locator => p.getByLabel(/электронная почта/i),
  requestLink: (p: Page): Locator => p.getByRole('button', { name: /получить ссылку/i }),
  /** "Проверь почту" after the link was requested. */
  sent: (p: Page): Locator => p.getByRole('heading', { name: /проверьте почту/i }),
  github: (p: Page): Locator => p.getByRole('button', { name: /войти через github/i }),
  /** 429 state: the error alert and the retry hint with the countdown. */
  rateLimited: (p: Page): Locator =>
    p.getByRole('alert').filter({ hasText: /слишком много запросов/i }),
  retryHint: (p: Page): Locator => p.getByText(/повторить можно через/i),
};

export const confirmUi = {
  heading: (p: Page): Locator => p.getByRole('heading', { level: 1, name: /вход по ссылке/i }),
  /**
   * architecture 13.8 describes a confirm button; the page may also confirm by itself on load.
   * `completeSignInLink` presses the button only when it is there.
   */
  confirmButton: (p: Page): Locator => p.getByRole('button', { name: /подтвердить( вход)?/i }),
  missingToken: (p: Page): Locator =>
    p.getByRole('alert').filter({ hasText: /нет данных для входа/i }),
};

export const consentUi = {
  heading: (p: Page): Locator =>
    p.getByRole('heading', { level: 1, name: /согласие на обработку персональных данных/i }),
  /** The section and the scrollable text box share the name; the section contains both. */
  text: (p: Page): Locator => p.getByRole('region', { name: /текст согласия/i }).first(),
  accept: (p: Page): Locator => p.getByRole('button', { name: /^принимаю$/i }),
  decline: (p: Page): Locator => p.getByRole('button', { name: /не принимаю/i }),
};

export const headerUi = {
  signOut: (p: Page): Locator => p.getByRole('button', { name: /^выйти$/i }),
};

export const profileUi = {
  heading: (p: Page): Locator => p.getByRole('heading', { level: 1, name: /мой профиль/i }),
  name: (p: Page): Locator => p.getByLabel(/^имя/i),
  timezone: (p: Page): Locator => p.getByLabel(/часовой пояс/i),
  hours: (p: Page): Locator => p.getByLabel(/часов в неделю на проект/i),
  portfolio: (p: Page): Locator => p.getByLabel(/ссылка на портфолио/i),
  strengths: (p: Page): Locator => p.getByLabel(/сильные стороны/i),
  weaknesses: (p: Page): Locator => p.getByLabel(/слабые стороны/i),
  save: (p: Page): Locator => p.getByRole('button', { name: /сохранить профиль/i }),
  saved: (p: Page): Locator => p.getByText(/профиль сохранён/i),
  // roles: an ordered list, the position is the priority
  roleAdd: (p: Page): Locator => p.getByLabel(/добавить роль/i),
  roleRows: (p: Page): Locator => p.getByRole('listitem').filter({ hasText: /приоритет \d/i }),
  roleLevel: (p: Page, index: number): Locator => p.getByLabel(/^уровень/i).nth(index),
  roleUp: (p: Page, roleName: string): Locator =>
    p.getByRole('button', { name: new RegExp(`поднять роль ${escapeRegExp(roleName)} выше`, 'i') }),
  // stack: a filter box over a checkbox list
  stackSearch: (p: Page): Locator => p.getByLabel(/найти технологию/i),
  stackTag: (p: Page, tagName: string): Locator =>
    p.getByRole('checkbox', { name: tagName, exact: true }),
  // experience: one group per entry
  experienceAdd: (p: Page): Locator => p.getByRole('button', { name: /добавить запись/i }),
  experienceEntry: (p: Page, n: number): Locator =>
    p.getByRole('group', { name: new RegExp(`запись ${n}`, 'i') }),
  viewPublic: (p: Page): Locator => p.getByRole('link', { name: /как видят другие/i }),
};

/** Fields inside one experience group (pass `profileUi.experienceEntry(page, n)`). */
export const experienceFields = {
  title: (entry: Locator): Locator => entry.getByLabel(/название/i),
  description: (entry: Locator): Locator => entry.getByLabel(/описание/i),
  from: (entry: Locator): Locator => entry.getByLabel(/начало/i),
  to: (entry: Locator): Locator => entry.getByLabel(/окончание/i),
};

export const resumeUi = {
  heading: (p: Page): Locator => p.getByRole('heading', { name: /^резюме$/i }),
  file: (p: Page): Locator => p.getByLabel(/файл резюме/i),
  upload: (p: Page): Locator => p.getByRole('button', { name: /^загрузить$/i }),
  /** The aria-live parse status ("Разбор готов…" is the "ready" state). */
  status: (p: Page): Locator => p.getByRole('status', { name: /статус разбора/i }),
  readyText: /разбор завершён|готово|ready/i,
  queuedOrProcessing: /в очереди|разбираем/i,
  failedText: /не удалось разобрать|нет текста|слишком (сложный|много времени)|повреждён/i,
  assessmentHeading: (p: Page): Locator => p.getByRole('heading', { name: 'Оценка резюме' }),
  suggestions: (p: Page): Locator => p.getByRole('group', { name: /предложения для профиля/i }),
  keepFile: (p: Page): Locator => p.getByRole('checkbox', { name: /хранить файл резюме/i }),
  confirm: (p: Page): Locator => p.getByRole('button', { name: /подтвердить выбранные поля/i }),
  remove: (p: Page): Locator => p.getByRole('button', { name: /^удалить резюме$/i }),
  removeConfirm: (p: Page): Locator => p.getByRole('button', { name: /да, удалить резюме/i }),
};

export const publicProfileUi = {
  name: (p: Page, displayName: string): Locator =>
    p.getByRole('heading', { level: 1, name: displayName }),
  rolesHeading: (p: Page): Locator => p.getByRole('heading', { name: /^роли$/i }),
  stackHeading: (p: Page): Locator => p.getByRole('heading', { name: /^стек$/i }),
  notFound: (p: Page): Locator => p.getByText(/профиль не найден/i),
};

export const settingsUi = {
  heading: (p: Page): Locator => p.getByRole('heading', { level: 1, name: /^аккаунт$/i }),
  githubLinked: (p: Page, login: string): Locator =>
    p.getByText(new RegExp(`привязан аккаунт ${escapeRegExp(login)}`, 'i')),
  openDeletion: (p: Page): Locator => p.getByRole('button', { name: /удалить аккаунт/i }),
  /** The confirmation is inline (or a dialog); the checkbox and the button are found page-wide. */
  deletionCheck: (p: Page): Locator => p.getByRole('checkbox', { name: /я понимаю/i }),
  deletionConfirm: (p: Page): Locator => p.getByRole('button', { name: /запросить удаление/i }),
  deletionRequested: (p: Page): Locator => p.getByText(/запрос на удаление принят/i),
};

export const cancelDeletionUi = {
  heading: (p: Page): Locator =>
    p.getByRole('heading', { level: 1, name: /отмена удаления аккаунта/i }),
  done: (p: Page): Locator => p.getByText(/удаление отменено/i),
};

/** Escapes text for use inside a RegExp. */
export function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
