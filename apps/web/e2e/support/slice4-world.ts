import { randomUUID } from 'node:crypto';
import { expect, type APIRequestContext } from '@playwright/test';
import { apiGet, apiPost, apiPut, ORIGIN_HEADERS, type ApiResult } from './api';
import { openSession, signInWithGithub, type Person, type Session } from './slice3-world';

/**
 * State shared by the steps of the slice 4 scenario (the tests run serially in one worker).
 * Three people: A leads a team with one open Backend seat; B stands in the queue, is auto-added and
 * later excluded; C leads a second team that B finds in the recommendations (A's team is never
 * recommended to B again, FR-MATCH-08).
 * They sign in through the GitHub double like in slice 3 (a linked GitHub account is required for
 * the queue, FR-AUTH-05, and for the auto-add, FR-MATCH-07).
 */

export type PersonKey = 'a' | 'b' | 'c';

export const world = {
  teamName: `Команда подбора ${Date.now()}`,
  teamId: '',
  seatId: '',
  /** enqueuedAt of B's application: the exclusion must bring the same wait back (FR-MATCH-08). */
  enqueuedAt: '',
  applicationId: '',
  /** `queuedCandidates` of Backend right before B stood in the queue (step 3 compares against it). */
  queuedBefore: 0,
  /** The second team (led by C) that B finds in the recommendations after A excluded him (step 7). */
  otherTeamName: `Соседняя команда ${Date.now()}`,
  otherTeamId: '',
  otherSeatId: '',
};

let people: Record<PersonKey, Person> | undefined;

export function setPeople(value: Record<PersonKey, Person> | undefined): void {
  people = value;
}

export function person(key: PersonKey): Person {
  if (!people) throw new Error('the people of the scenario are not signed in yet');
  return people[key];
}

export { openSession, signInWithGithub };
export type { Session };

export const DISPLAY_NAMES: Record<PersonKey, string> = {
  a: 'Анна Лидова',
  b: 'Борис Очередин',
  c: 'Кирилл Соседов',
};

export function get<T>(who: Person, path: string): Promise<ApiResult<T>> {
  return apiGet<T>(who.session.context.request, path);
}

export function post<T>(who: Person, path: string, data?: unknown): Promise<ApiResult<T>> {
  return apiPost<T>(who.session.context.request, path, data ?? {}, {
    'Idempotency-Key': randomUUID(),
  });
}

export function put<T>(who: Person, path: string, data: unknown): Promise<ApiResult<T>> {
  return apiPut<T>(who.session.context.request, path, data, { 'Idempotency-Key': randomUUID() });
}

/** PATCH has no helper in support/api.ts (only slice 4 sets a seat's minimum hours through the API). */
export async function patch<T>(
  request: APIRequestContext,
  path: string,
  data: unknown,
): Promise<ApiResult<T>> {
  const response = await request.patch(`/api${path}`, {
    data,
    headers: { ...ORIGIN_HEADERS, 'Idempotency-Key': randomUUID() },
  });
  const text = await response.text();
  let body: unknown;
  try {
    body = text === '' ? undefined : JSON.parse(text);
  } catch {
    body = undefined;
  }
  return { status: response.status(), headers: response.headers(), body: body as T, text };
}

export interface TeamBody {
  id: string;
  status: string;
  timezone: string;
  leadUserId: string | null;
  memberCount: number;
  seats: {
    id: string;
    roleCode: string;
    status: string;
    holderUserId: string | null;
    version: number;
  }[];
  members: {
    userId: string;
    displayName: string;
    status: string;
    joinedVia: string;
    joinedAt: string;
    trialUntil: string | null;
  }[];
}

export async function teamAs(who: Person): Promise<TeamBody> {
  const response = await get<TeamBody>(who, `/v1/teams/${world.teamId}`);
  expect(response.status, response.text).toBe(200);
  return response.body;
}

export interface ApplicationBody {
  id: string;
  status: string;
  enqueuedAt: string;
  roles: { roleCode: string; priority: number }[];
  version: number;
}

export interface DemandItem {
  roleCode: string;
  teamsSeeking: number;
  openSeats: number;
  queuedCandidates: number;
}

export async function demandOf(who: Person, roleCode: string): Promise<DemandItem | undefined> {
  const response = await get<{ items: DemandItem[] }>(who, `/v1/demand?roles=${roleCode}`);
  expect(response.status, response.text).toBe(200);
  return response.body.items[0];
}

/**
 * Saves B's profile as a Backend candidate: a role preference, the time zone of A's team (so the
 * 6-hour limit of C-43 cannot interfere) and `hoursPerWeek`. Step 2 saves 10 hours (below the 30 the
 * seat asks for, so the worker leaves B in the queue until step 4); step 4 saves 40.
 */
export async function saveCandidateProfile(
  who: Person,
  options: { hoursPerWeek: number; timezone: string },
): Promise<void> {
  const current = await get<{ version: number }>(who, '/v1/me/profile');
  expect(current.status, current.text).toBe(200);
  const saved = await put(who, '/v1/me/profile', {
    displayName: who.name,
    timezone: options.timezone,
    hoursPerWeek: options.hoursPerWeek,
    stack: [],
    rolePrefs: [{ roleCode: 'backend', level: 'middle' }],
    experience: [],
    strengths: [],
    weaknesses: [],
    version: current.body.version,
  });
  expect(saved.status, saved.text).toBe(200);
}
