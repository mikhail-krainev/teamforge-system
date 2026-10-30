import path from 'node:path';
import { expect, type Browser, type BrowserContext, type Page } from '@playwright/test';
import { apiGet, type CatalogEntry } from './api';
import { uniqueEmail } from './auth';
import { onWebOrigin } from './mail';
import { confirmUi, ROUTES } from './slice2-ui';
import { E2E_WEB_URL, ROOT } from './stack';

/** State shared by the steps of the slice 2 scenario (the tests run serially in one worker). */

export const RESUME_PDF = path.join(ROOT, 'apps/api/test/fixtures/files/resume.pdf');
export const WEB_ORIGIN = new URL(E2E_WEB_URL).origin;

export const PROFILE = {
  name: 'Иван Петров',
  timezone: 'Europe/Moscow',
  hours: '15',
  portfolio: 'https://example.test/ivan',
  strength: 'Быстро учусь новому',
  weakness: 'Плохо оцениваю сроки',
  experience: {
    title: 'Корнер: учебный проект',
    description: 'Разрабатывал серверную часть и тесты.',
    from: '2024-02-01',
    to: '2025-06-30',
  },
};

export interface ProfileBody {
  displayName: string;
  timezone: string;
  hoursPerWeek: number;
  stack: string[];
  rolePrefs: { roleCode: string; level: string }[];
  experience: { title: string; from: string; to?: string | null }[];
  version: number;
}

export interface Session {
  context: BrowserContext;
  page: Page;
}

export interface Sessions {
  /** The main user: signs in through the UI, fills the profile, deletes and restores the account. */
  ivan: Session;
  /** No session at all. */
  guest: Session;
  /** A second user who looks at the public profile. */
  viewer: Session;
  /** A third user who signs in with GitHub. */
  githubUser: Session;
}

export const world = {
  ivanEmail: uniqueEmail('ivan'),
  ivanId: '',
  signInLink: '',
  cancelLink: '',
  versionBeforeResume: 0,
  roles: [] as CatalogEntry[],
  tags: [] as CatalogEntry[],
};

let current: Sessions | undefined;

export function setSessions(sessions: Sessions | undefined): void {
  current = sessions;
}

export function sessions(): Sessions {
  if (!current) throw new Error('browser sessions are not open yet');
  return current;
}

export async function openSession(browser: Browser): Promise<Session> {
  const context = await browser.newContext({ baseURL: E2E_WEB_URL, locale: 'ru-RU' });
  return { context, page: await context.newPage() };
}

/** Opens the link from the mail and presses the confirm button if the page has one. */
export async function completeSignInLink(page: Page, link: string): Promise<void> {
  // A mail link opens in a fresh navigation. From /auth/confirm (no token) it would be a
  // fragment-only change of the same document: no reload, so the page would never read the token.
  await page.goto('about:blank');
  await page.goto(onWebOrigin(link));
  await expect(async () => {
    const onConfirm = new URL(page.url()).pathname.startsWith(ROUTES.confirm);
    if (onConfirm) {
      const button = confirmUi.confirmButton(page);
      if (await button.isVisible()) await button.click();
    }
    expect(new URL(page.url()).pathname.startsWith(ROUTES.confirm), 'left /auth/confirm').toBe(
      false,
    );
  }).toPass({ timeout: 30_000 });
}

/** Wanted entries by code first, topped up from the rest of the active ones. */
function choose(items: CatalogEntry[], preferred: string[], count: number): CatalogEntry[] {
  // One entry per code: the same tag can come from several lookups as distinct objects.
  const active = [...new Map(items.filter((item) => item.active).map((i) => [i.code, i])).values()];
  const first = preferred.flatMap((code) => active.filter((item) => item.code === code));
  const rest = active.filter((item) => !first.includes(item));
  return [...first, ...rest].slice(0, count);
}

/** Two roles and three stack tags from the real catalogs (the resume mentions TypeScript, PostgreSQL, Redis). */
export async function chooseFromCatalogs(context: BrowserContext): Promise<void> {
  const roles = await apiGet<{ items: CatalogEntry[] }>(context.request, '/v1/catalog/roles');
  expect(roles.status, roles.text).toBe(200);
  const wanted = ['typescript', 'postgresql', 'redis'];
  const tags: CatalogEntry[] = [];
  for (const code of wanted) {
    const found = await apiGet<{ items: CatalogEntry[] }>(
      context.request,
      `/v1/catalog/stack-tags?prefix=${code}`,
    );
    tags.push(...(found.body?.items ?? []).filter((tag) => tag.code === code));
  }
  const page = await apiGet<{ items: CatalogEntry[] }>(
    context.request,
    '/v1/catalog/stack-tags?limit=50',
  );
  expect(page.status, page.text).toBe(200);
  world.roles = choose(roles.body.items, ['backend', 'frontend'], 2);
  world.tags = choose([...tags, ...page.body.items], wanted, 3);
  expect(world.roles, 'the role catalog has at least 2 active roles').toHaveLength(2);
  expect(world.tags, 'the stack catalog has at least 3 active tags').toHaveLength(3);
}

export async function myProfile(context: BrowserContext): Promise<ProfileBody> {
  const response = await apiGet<ProfileBody>(context.request, '/v1/me/profile');
  expect(response.status, response.text).toBe(200);
  return response.body;
}
