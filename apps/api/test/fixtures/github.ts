import { randomUUID } from 'node:crypto';
import { expect } from 'vitest';
import type { Schema } from 'shared';
import {
  type RepoSpec,
  type TwinAccount,
  type TwinInstallation,
  type TwinItem,
  type TwinRepo,
} from '../fakes/github-app.js';
import type { TwinPerson, WebhookRequest, WebhookSink } from '../fakes/github-webhooks.js';
import type { InjectResponse } from '../helpers/http.js';
import { waitFor } from '../helpers/infra.js';
import type { UserFixture } from './index.js';
import { expectOk } from './teams.js';
import { contributionCount, deliveryRows } from './github-db.js';
import type { World } from './world.js';

/**
 * Slice 6 fixtures of the github module (docs/plan.md S6-02): the installation of the GitHub App, the
 * link of a repository and the webhooks, all through the production path (HTTP) with the GitHub App
 * double (`test/fakes/github-app.ts`) on the other side. The assumptions about the not yet written
 * implementation are marked in the text; they sit here so that S6-03..S6-08 adjust one place.
 */

export type InstallationSessionDto = Schema<'InstallationSession'>;
export type AvailableRepositoryListDto = Schema<'AvailableRepositoryList'>;
export type RepositoryLinkDto = Schema<'RepositoryLink'>;

export const SETUP_PATH = '/v1/github/setup';

/** The GitHub identity (numeric id and login) the fixture user signed up with. */
export async function ghPerson(world: World, user: UserFixture): Promise<TwinPerson> {
  const rows = await world.sql<{ github_user_id: string | number; github_login: string }[]>`
    SELECT github_user_id, github_login FROM auth."user" WHERE id = ${user.id}`;
  const row = rows[0];
  if (!row) throw new Error(`user ${user.id} has no linked GitHub account`);
  return { id: Number(row.github_user_id), login: row.github_login };
}

/** A personal account owned by the person (the usual installation of a student). */
export const personalAccount = (
  person: TwinPerson,
  extra: Partial<TwinAccount> = {},
): TwinAccount => ({
  id: person.id,
  login: person.login,
  type: 'User',
  ...extra,
});

export function github(world: World): NonNullable<World['github']> {
  if (!world.github) throw new Error('this scenario needs World.start({ github: true })');
  return world.github;
}

// ---- the installation (7.2) ---------------------------------------------------------------------

export function createSession(
  world: World,
  who: UserFixture,
  teamId: string,
  key?: string,
): Promise<InjectResponse> {
  return world.as(who).post(`/v1/teams/${teamId}/github/installation-sessions`, undefined, {
    ...(key === undefined ? {} : { idempotencyKey: key }),
  });
}

/** `state` of the install URL the application returned (the value GitHub gives back on the callback). */
export function stateOf(session: InstallationSessionDto): string {
  const state = new URL(session.installUrl).searchParams.get('state');
  if (!state) throw new Error(`installUrl carries no state: ${session.installUrl}`);
  return state;
}

export async function startSession(
  world: World,
  lead: UserFixture,
  teamId: string,
): Promise<{ session: InstallationSessionDto; state: string }> {
  const session = expectOk<InstallationSessionDto>(
    'createInstallationSession',
    await createSession(world, lead, teamId),
    201,
  );
  return { session, state: stateOf(session) };
}

export const setupUrl = (query: Record<string, string>): string =>
  `${SETUP_PATH}?${new URLSearchParams(query).toString()}`;

/** `GET /v1/github/setup` as the user whose session the browser carries. */
export function callback(
  world: World,
  who: UserFixture,
  query: Record<string, string>,
): Promise<InjectResponse> {
  return world.as(who).get(setupUrl(query));
}

/** Location of a redirect as a URL on the app origin. */
export function locationOf(response: InjectResponse, world: World): URL {
  const location = response.headers.location;
  if (typeof location !== 'string') {
    throw new Error(`no Location in HTTP ${response.statusCode}: ${response.body}`);
  }
  return new URL(location, world.origin);
}

/**
 * The callback ended with a refusal (contract: a redirect with `?error=`; the plan also allows 400/403
 * for a state of another user): nothing is granted. Returns the error value when it is a redirect.
 */
export function expectSetupRefused(response: InjectResponse, world: World): string | undefined {
  if (response.statusCode === 302) {
    const error = locationOf(response, world).searchParams.get('error');
    expect(error, `redirect without error: ${String(response.headers.location)}`).toBeTruthy();
    return error ?? undefined;
  }
  expect([400, 403], `setup callback answered ${response.statusCode}: ${response.body}`).toContain(
    response.statusCode,
  );
  return undefined;
}

export function expectSetupGranted(
  response: InjectResponse,
  world: World,
  installationId: number,
): void {
  expect(response.statusCode, response.body).toBe(302);
  const target = locationOf(response, world);
  expect(target.searchParams.get('error')).toBeNull();
  expect(target.searchParams.get('installation')).toBe(String(installationId));
}

export interface Installed {
  state: string;
  installation: TwinInstallation;
  query: Record<string, string>;
  response: InjectResponse;
}

/**
 * Session, GitHub dialog (the double), callback: the lead installs the App on a personal account and
 * the application grants the installation to this team. `account` defaults to the lead's own account.
 */
export async function installApp(
  world: World,
  lead: UserFixture,
  teamId: string,
  options: { account?: TwinAccount; repos?: RepoSpec[] } = {},
): Promise<Installed> {
  const { state } = await startSession(world, lead, teamId);
  const person = await ghPerson(world, lead);
  const account = options.account ?? personalAccount(person);
  const result = github(world).app.install(person, account, {
    state,
    ...(options.repos ? { repos: options.repos } : {}),
  });
  if (!result.installation) throw new Error('the double refused the installation');
  const response = await callback(world, lead, result.query);
  expectSetupGranted(response, world, result.installation.id);
  return { state, installation: result.installation, query: result.query, response };
}

export function availableRepositories(
  world: World,
  lead: UserFixture,
  teamId: string,
  installationId: number,
  extra = '',
): Promise<InjectResponse> {
  return world
    .as(lead)
    .get(
      `/v1/teams/${teamId}/github/available-repositories?installationId=${installationId}${extra}`,
    );
}

export function link(
  world: World,
  who: UserFixture,
  teamId: string,
  body: { installationId: number; repositoryId: number },
  key?: string,
): Promise<InjectResponse> {
  return world.as(who).put(`/v1/teams/${teamId}/repository`, body, {
    ...(key === undefined ? {} : { idempotencyKey: key }),
  });
}

export function getRepository(
  world: World,
  who: UserFixture,
  teamId: string,
): Promise<InjectResponse> {
  return world.as(who).get(`/v1/teams/${teamId}/repository`);
}

export function unlink(world: World, who: UserFixture, teamId: string): Promise<InjectResponse> {
  return world.as(who).delete(`/v1/teams/${teamId}/repository`);
}

export interface Connected extends Installed {
  repo: TwinRepo;
  link: RepositoryLinkDto;
}

let repoSerial = 0;

/** A repository with `commits` commits split between the people (FR-GH-08: at least 10, 2 accounts). */
export function repoSpec(people: TwinPerson[], overrides: Partial<RepoSpec> = {}): RepoSpec {
  repoSerial += 1;
  return {
    name: `project-${repoSerial}-${randomUUID().slice(0, 6)}`,
    contributors: people.map((person) => ({ ...person, contributions: 6 })),
    ...overrides,
  };
}

/**
 * Installs the App for the lead, lists the repositories and links the first one to the team: the whole
 * flow of 7.2 up to `repo_link`. `members` are the people whose GitHub accounts commit to the repository.
 */
export async function connectRepository(
  world: World,
  team: { id: string; lead: UserFixture },
  members: UserFixture[],
  options: { repo?: Partial<RepoSpec>; account?: TwinAccount } = {},
): Promise<Connected> {
  const people = await Promise.all(members.map((m) => ghPerson(world, m)));
  const spec = repoSpec(people, options.repo);
  const installed = await installApp(world, team.lead, team.id, {
    ...(options.account ? { account: options.account } : {}),
    repos: [spec],
  });
  const listed = expectOk<AvailableRepositoryListDto>(
    'listAvailableRepositories',
    await availableRepositories(world, team.lead, team.id, installed.installation.id),
    200,
  );
  const fullName = `${installed.installation.account.login}/${spec.name}`;
  const found = listed.items.find((r) => r.fullName === fullName);
  if (!found) throw new Error(`${fullName} is not among the available repositories`);
  const linked = expectOk<RepositoryLinkDto>(
    'linkRepository',
    await link(world, team.lead, team.id, {
      installationId: installed.installation.id,
      repositoryId: found.repositoryId,
    }),
    200,
  );
  return { ...installed, repo: github(world).app.repo(found.repositoryId), link: linked };
}

// ---- webhooks (7.3) -----------------------------------------------------------------------------

export const WEBHOOK_URL = '/api/v1/webhooks/github';

/** Hands a delivery to the application like GitHub: the raw body and the headers, no session. */
export function postWebhook(world: World, request: WebhookRequest): Promise<InjectResponse> {
  return world.app.inject({
    method: 'POST',
    url: WEBHOOK_URL,
    headers: request.headers,
    payload: request.body,
  });
}

export const webhookSink = (world: World): WebhookSink => {
  return async (request) => ({ status: (await postWebhook(world, request)).statusCode });
};

const FINISHED = new Set(['processed', 'ignored', 'failed']);

/** Waits until the worker has dealt with the delivery; returns its final status. */
export async function waitForDelivery(
  world: World,
  deliveryId: string,
  timeoutMs = 20_000,
): Promise<string> {
  return waitFor(async () => {
    const status = (await deliveryRows(world, deliveryId))[0]?.status;
    return status && FINISHED.has(status) ? status : false;
  }, timeoutMs);
}

/** Delivers a signed event, expects 202 and waits for the worker. */
export async function deliverAndWait(world: World, request: WebhookRequest): Promise<string> {
  const response = await postWebhook(world, request);
  expect(response.statusCode, response.body).toBe(202);
  return waitForDelivery(world, request.headers['x-github-delivery'] ?? '');
}

export async function waitForContributions(
  world: World,
  teamId: string,
  count: number,
  filter: { source?: string; userId?: string; active?: boolean } = {},
  timeoutMs = 20_000,
): Promise<void> {
  await waitFor(async () => (await contributionCount(world, teamId, filter)) >= count, timeoutMs);
}

/** `issues` closed for the double's issue: opened and closed on GitHub, then delivered. */
export async function closedIssueDelivered(
  world: World,
  repo: TwinRepo,
  spec: { author: TwinPerson; assignees?: TwinPerson[]; labels?: string[]; title?: string },
): Promise<{ item: TwinItem; deliveryId: string }> {
  const app = github(world).app;
  const item = app.openIssue(repo.id, spec);
  app.closeIssue(repo.id, item.number);
  const request = app.issuesEvent('closed', item);
  await deliverAndWait(world, request);
  return { item, deliveryId: request.headers['x-github-delivery'] ?? '' };
}

/** A pull request opened, merged on GitHub and delivered as `pull_request` closed + merged. */
export async function mergedPullDelivered(
  world: World,
  repo: TwinRepo,
  spec: {
    author: TwinPerson;
    labels?: string[];
    title?: string;
    additions?: number;
    deletions?: number;
  },
): Promise<{ item: TwinItem; deliveryId: string }> {
  const app = github(world).app;
  const item = app.openPull(repo.id, spec);
  app.mergePull(repo.id, item.number);
  const request = app.pullRequestEvent('closed', item);
  await deliverAndWait(world, request);
  return { item, deliveryId: request.headers['x-github-delivery'] ?? '' };
}

export const issueRef = (repo: { id: number }, number: number): string =>
  `issue:${repo.id}#${number}`;
export const pullRef = (repo: { id: number }, number: number): string => `pr:${repo.id}#${number}`;

/** Name of the maintenance task of the daily reconciliation (docs/plan.md S6-06: `github-sync`). */
export const GITHUB_SYNC_TASK = 'github-sync';
/** Sweeper that re-queues deliveries stuck in `received` (architecture 7.3 item 3). */
export const WEBHOOK_SWEEPER_TASK = 'webhook-sweeper';
