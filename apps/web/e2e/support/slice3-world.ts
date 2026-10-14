import { randomUUID } from 'node:crypto';
import { expect, type Browser, type BrowserContext, type Page } from '@playwright/test';
import { acceptConsentViaApi } from './auth';
import { apiGet, apiPost, apiPut, type ApiResult, type Me } from './api';
import { githubDouble, githubIdentity, routeGithubDoubleToLoopback } from './github';
import { signInUi } from './slice2-ui';
import { compose, E2E_WEB_URL } from './stack';

/** State shared by the steps of the slice 3 scenario (the tests run serially in one worker). */

export const WEB_ORIGIN = new URL(E2E_WEB_URL).origin;

export interface Session {
  context: BrowserContext;
  page: Page;
}

export interface Person {
  /** Display name the team page shows (saved to the profile by `signInWithGithub`). */
  name: string;
  id: string;
  login: string;
  session: Session;
}

export type PersonKey = 'a' | 'b' | 'c' | 'd' | 'e';

export const world = {
  teamName: `Команда ${Date.now()}`,
  teamId: '',
  inviteLink: '',
  inviteToken: '',
  /** The last seat's winner of the D/E race (step 5) and the loser. */
  raceWinner: undefined as PersonKey | undefined,
};

let people: Record<PersonKey, Person> | undefined;

export function setPeople(value: Record<PersonKey, Person> | undefined): void {
  people = value;
}

export function person(key: PersonKey): Person {
  if (!people) throw new Error('the people of the scenario are not signed in yet');
  return people[key];
}

export async function openSession(browser: Browser): Promise<Session> {
  const context = await browser.newContext({ baseURL: E2E_WEB_URL, locale: 'ru-RU' });
  return { context, page: await context.newPage() };
}

/**
 * Signs a fresh browser session in with GitHub through the double (so that GitHub is linked, which
 * createTeam / joining require, FR-AUTH-05) and accepts the consent through the API.
 */
export async function signInWithGithub(session: Session, label: string): Promise<Person> {
  const double = await githubDouble();
  const identity = githubIdentity(`e2e3-${label}-${Date.now()}`, { name: label });
  await routeGithubDoubleToLoopback(session.context);
  double.nextLogin(identity);
  await session.page.goto('/sign-in');
  await signInUi.github(session.page).click();
  await session.page.waitForURL(
    (url) =>
      url.origin === WEB_ORIGIN &&
      !url.pathname.startsWith('/sign-in') &&
      !url.pathname.startsWith('/api'),
    { timeout: 60_000 },
  );
  await acceptConsentViaApi(session.context);
  const me = await apiGet<Me>(session.context.request, '/v1/me');
  expect(me.status, me.text).toBe(200);
  // Names on the team page come from the profile (a person without one is shown as a deleted user).
  const saved = await apiPut(
    session.context.request,
    '/v1/me/profile',
    {
      displayName: label,
      timezone: 'Europe/Moscow',
      hoursPerWeek: 10,
      stack: [],
      rolePrefs: [],
      experience: [],
      strengths: [],
      weaknesses: [],
      version: null,
    },
    { 'Idempotency-Key': randomUUID() },
  );
  expect(saved.status, saved.text).toBe(200);
  return { name: label, id: me.body.id, login: identity.login, session };
}

/** A state-changing API call as `who`, with a fresh Idempotency-Key (setup that is not the step under test). */
export function post<T>(who: Person, path: string, data?: unknown): Promise<ApiResult<T>> {
  return apiPost<T>(who.session.context.request, path, data ?? {}, {
    'Idempotency-Key': randomUUID(),
  });
}

export function get<T>(who: Person, path: string): Promise<ApiResult<T>> {
  return apiGet<T>(who.session.context.request, path);
}

export interface TeamBody {
  id: string;
  status: string;
  leadUserId: string | null;
  memberCount: number;
  startedAt?: string | null;
  seats: { id: string; roleCode: string; status: string; holderUserId: string | null }[];
  members: { userId: string; displayName: string; isLead: boolean }[];
}

export async function teamAs(who: Person): Promise<TeamBody> {
  const response = await get<TeamBody>(who, `/v1/teams/${world.teamId}`);
  expect(response.status, response.text).toBe(200);
  return response.body;
}

/**
 * Makes the nomination period of the open vote over (C-16 is 24 hours, too long for a test): the
 * deadline in `teams.leader_vote` is moved into the past and the `vote-deadline-scan` that the worker
 * runs every minute (architecture 8.3, "страховка") picks it up. Only the documented column is touched.
 */
export function expireVotePhase(teamId: string, status: 'nominating' | 'voting'): void {
  const sql = `UPDATE teams.leader_vote SET phase_deadline = now() - interval '1 minute' WHERE team_id = '${teamId}' AND status = '${status}'`;
  compose('exec', '-T', 'postgres', 'psql', '-U', 'postgres', '-d', 'teamforge', '-c', sql);
}
