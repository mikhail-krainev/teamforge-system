import { randomUUID } from 'node:crypto';
import { expect } from '@playwright/test';
import type { WebhookRequest } from '../../../api/test/fakes/github-webhooks';
import { apiGet, ORIGIN_HEADERS } from './api';
import { githubDouble, type GithubServer } from './github';
import * as slice5 from './slice5-world';
import { get, openSession, post, put, signInWithGithub, type Person } from './slice5-world';
import { compose, E2E_WEB_URL } from './stack';

/**
 * State shared by the steps of the slice 6 scenario (the tests run serially in one worker).
 * Five people sign in through the GitHub double: `admin` publishes the playbook (slice 5 setup), A leads
 * the team, B holds Backend (and later DevOps), C holds Frontend, D leads a second team that wants the same
 * repository (step 5). The team, the playbook and the route are those of slice 5 (`slice5-world`).
 * GitHub (the App, the repository, the webhooks) is the double of apps/api/test/fakes/github-app.ts.
 */

export type PersonKey = 'admin' | 'a' | 'b' | 'c' | 'd';

export const DISPLAY_NAMES: Record<PersonKey, string> = {
  ...slice5.DISPLAY_NAMES,
  d: 'Дмитрий Соседов',
};

export const world = {
  /** The repository the first team bound in step 1. */
  repo: { id: 0, fullName: '', installationId: 0 },
  /** The second team (led by D), created in step 5. */
  otherTeamId: '',
  otherTeamName: `Соседняя команда ${Date.now()}`,
  /** `ref`s of the contributions the webhooks produced in step 2. */
  titles: [] as string[],
  /**
   * The release address of the project under test: a page the link-checker container can reach. AF-02 refuses
   * an address that another completed project holds, so a later scenario on the same stack sets its own.
   */
  releaseUrl: process.env.E2E_RELEASE_URL ?? 'https://www.wikipedia.org/',
};

let people: Record<PersonKey, Person> | undefined;

export function setPeople(value: Record<PersonKey, Person> | undefined): void {
  people = value;
  slice5.setPeople(value ? { admin: value.admin, a: value.a, b: value.b, c: value.c } : undefined);
}

export function person(key: PersonKey): Person {
  if (!people) throw new Error('the people of the scenario are not signed in yet');
  return people[key];
}

export const teamId = (): string => slice5.world.teamId;

export { get, openSession, post, put, signInWithGithub };
export type { Person };

export interface GithubIdentityRef {
  id: number;
  login: string;
}

/** The numeric GitHub id and login the person signed in with (the double's identity), from `getMyGithubAccount`. */
export async function githubOf(who: Person): Promise<GithubIdentityRef> {
  const response = await apiGet<{ linked: boolean; githubUserId: number; login: string }>(
    who.session.context.request,
    '/v1/me/github',
  );
  expect(response.status, response.text).toBe(200);
  expect(response.body.linked).toBe(true);
  return { id: Number(response.body.githubUserId), login: response.body.login };
}

export async function double(): Promise<GithubServer> {
  const server = await githubDouble();
  server.app.callbackUrl = `${E2E_WEB_URL}/api/v1/github/setup`;
  return server;
}

/** GitHub's delivery to the application: through the web origin, like the proxy that fronts the api. */
export async function deliver(request: WebhookRequest): Promise<number> {
  const response = await fetch(`${E2E_WEB_URL}/api/v1/webhooks/github`, {
    method: 'POST',
    headers: request.headers,
    body: request.body,
  });
  return response.status;
}

export { ORIGIN_HEADERS };

// ---- time: the throwaway e2e database is moved instead of waiting (as backdateStage of slice 5) -------

const psql = (sql: string): void => {
  compose('exec', '-T', 'postgres', 'psql', '-U', 'postgres', '-d', 'teamforge', '-c', sql);
};

/**
 * The first check of the release is made 25 hours earlier (FR-WORK-14: the second one is not earlier than
 * C-53 = 24 h after the first). Only the documented column of `workspace.release_check` is touched.
 */
export function ageReleaseChecks(teamId: string, hours = 25): void {
  psql(
    `UPDATE workspace.release_check SET checked_at = checked_at - interval '${hours} hours' WHERE team_id = '${teamId}'`,
  );
}

/**
 * The project began 15 days ago (C-06a: at least 14 days): every stage opened and closed 15 days earlier,
 * and the contributions are spread over three days (C-09: at least three days with a contribution).
 */
export function makeProjectOlder(teamId: string, days = 15): void {
  psql(
    `UPDATE workspace.project_stage SET opened_at = opened_at - interval '${days} days', closed_at = closed_at - interval '${days} days', due_at = due_at - interval '${days} days' WHERE team_id = '${teamId}'`,
  );
  psql(
    `UPDATE teams.team SET started_at = started_at - interval '${days} days', planned_end_at = planned_end_at - interval '${days} days' WHERE id = '${teamId}'`,
  );
  psql(
    `WITH numbered AS (SELECT id, row_number() OVER (ORDER BY ref) AS n FROM workspace.contribution WHERE team_id = '${teamId}') UPDATE workspace.contribution c SET received_at = c.received_at - ((numbered.n % 3) || ' days')::interval, occurred_at = c.occurred_at - ((numbered.n % 3) || ' days')::interval FROM numbered WHERE c.id = numbered.id`,
  );
}

export function newKey(): string {
  return randomUUID();
}
