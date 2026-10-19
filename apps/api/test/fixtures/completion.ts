import { expect } from 'vitest';
import type { Schema } from 'shared';
import type { TwinPerson } from '../fakes/github-webhooks.js';
import type { InjectResponse } from '../helpers/http.js';
import { waitFor } from '../helpers/infra.js';
import {
  closedIssueDelivered,
  connectRepository,
  ghPerson,
  mergedPullDelivered,
  type Connected,
} from './github.js';
import type { UserFixture } from './index.js';
import { DAY, expectOk } from './teams.js';
import {
  advanceStage,
  clockOf,
  completeStageOne,
  completeStageTwo,
  doneWithLink,
  routeTeam,
  type RouteFixture,
} from './workspace.js';
import type { World } from './world.js';

/**
 * Slice 6 fixtures of the workspace module (docs/plan.md S6-02): the feed, the roles of contributions,
 * the completion check and the completion of a project. `completableTeam` is the expensive one: it
 * builds a team that meets every condition of FR-WORK-13 through the production path - route stages
 * closed one by one, GitHub work delivered by signed webhooks on three different days, a release link.
 * Tests then break exactly one condition.
 */

export type FeedEntryDto = Schema<'FeedEntry'>;
export type FeedEntryPageDto = Schema<'FeedEntryPage'>;
export type ContributionSummaryDto = Schema<'ContributionSummary'>;
export type CompletionCheckDto = Schema<'CompletionCheck'>;
export type CompletionDto = Schema<'Completion'>;

export const RELEASE_URL = 'https://app.release.example.test/';
/** C-06a: a project lasts at least 14 calendar days from the opening of the first stage. */
export const MIN_PROJECT_DAYS = 14;

// ---- API calls ----------------------------------------------------------------------------------

export function feed(
  world: World,
  who: UserFixture,
  teamId: string,
  query: Record<string, string | number> = {},
): Promise<InjectResponse> {
  const suffix = Object.keys(query).length
    ? `?${new URLSearchParams(
        Object.entries(query).map(([k, v]): [string, string] => [k, String(v)]),
      ).toString()}`
    : '';
  return world.as(who).get(`/v1/teams/${teamId}/feed${suffix}`);
}

export async function feedOk(
  world: World,
  who: UserFixture,
  teamId: string,
  query: Record<string, string | number> = {},
): Promise<FeedEntryPageDto> {
  return expectOk<FeedEntryPageDto>('getTeamFeed', await feed(world, who, teamId, query), 200);
}

/** All pages of the feed (cursor walk), in the order the API returns them. */
export async function feedAll(
  world: World,
  who: UserFixture,
  teamId: string,
  query: Record<string, string | number> = {},
  pageSize = 5,
): Promise<FeedEntryDto[]> {
  const entries: FeedEntryDto[] = [];
  let cursor: string | null = null;
  for (let page = 0; page < 50; page += 1) {
    const body: FeedEntryPageDto = await feedOk(world, who, teamId, {
      ...query,
      limit: pageSize,
      ...(cursor ? { cursor } : {}),
    });
    entries.push(...body.items);
    cursor = body.nextCursor;
    if (!cursor) return entries;
  }
  throw new Error('the feed did not end after 50 pages');
}

export function summary(world: World, who: UserFixture, teamId: string): Promise<InjectResponse> {
  return world.as(who).get(`/v1/teams/${teamId}/contributions/summary`);
}

export function relabel(
  world: World,
  who: UserFixture,
  teamId: string,
  contributionId: string,
  body: Record<string, unknown>,
  key?: string,
): Promise<InjectResponse> {
  return world.as(who).patch(`/v1/teams/${teamId}/contributions/${contributionId}`, body, {
    ...(key === undefined ? {} : { idempotencyKey: key }),
  });
}

export function requestCheck(
  world: World,
  who: UserFixture,
  teamId: string,
  key?: string,
): Promise<InjectResponse> {
  return world.as(who).post(`/v1/teams/${teamId}/completion-checks`, undefined, {
    ...(key === undefined ? {} : { idempotencyKey: key }),
  });
}

export function latestCheck(
  world: World,
  who: UserFixture,
  teamId: string,
): Promise<InjectResponse> {
  return world.as(who).get(`/v1/teams/${teamId}/completion-checks/latest`);
}

export function complete(
  world: World,
  who: UserFixture,
  teamId: string,
  key?: string,
): Promise<InjectResponse> {
  return world.as(who).post(`/v1/teams/${teamId}/completion`, undefined, {
    ...(key === undefined ? {} : { idempotencyKey: key }),
  });
}

export function completionOf(
  world: World,
  who: UserFixture,
  teamId: string,
): Promise<InjectResponse> {
  return world.as(who).get(`/v1/teams/${teamId}/completion`);
}

/** Waits until the worker has finished the check `checkId` (done or failed). */
export function waitForCheck(
  world: World,
  lead: UserFixture,
  teamId: string,
  checkId: string,
): Promise<CompletionCheckDto> {
  return waitFor(async () => {
    const response = await latestCheck(world, lead, teamId);
    if (response.statusCode !== 200) return false;
    const body = response.json<CompletionCheckDto>();
    return body.id === checkId && (body.status === 'done' || body.status === 'failed')
      ? body
      : false;
  }, 30_000);
}

/** Requests a check (202) and waits until the worker has finished it. */
export async function runCheck(
  world: World,
  lead: UserFixture,
  teamId: string,
): Promise<CompletionCheckDto> {
  const requested = expectOk<CompletionCheckDto>(
    'requestCompletionCheck',
    await requestCheck(world, lead, teamId),
    202,
  );
  return waitForCheck(world, lead, teamId, requested.id);
}

export const unmetCodes = (response: InjectResponse): string[] =>
  (response.json<{ unmet?: { code: string }[] }>().unmet ?? []).map((u) => u.code).sort();

// ---- the team that can be completed -------------------------------------------------------------

export interface CompletableTeam {
  fx: RouteFixture;
  connected: Connected;
  backend: TwinPerson;
  frontend: TwinPerson;
  /** References of the contributions delivered by webhooks (`issue:<repo>#<n>`, `pr:<repo>#<n>`). */
  refs: string[];
}

export interface CompletableOptions {
  /** Stop before the last "Перейти": the final stage stays open. */
  keepLastStageOpen?: boolean;
  /** Webhook contributions per working day (days 0, 1, 2); default 4, 3, 3 = 10. */
  perDay?: [number, number, number];
  /** Days between the opening of the final stage and its closing (the duration of FR-WORK-13). */
  daysBeforeFinish?: number;
  /** Only one member works on GitHub (CONTRIBUTORS_TOO_FEW). */
  singleAuthor?: boolean;
}

async function workDay(
  world: World,
  c: Pick<CompletableTeam, 'connected' | 'backend' | 'frontend' | 'refs'>,
  count: number,
  singleAuthor: boolean,
): Promise<void> {
  for (let i = 0; i < count; i += 1) {
    const who = singleAuthor || i % 2 === 0 ? c.backend : c.frontend;
    if (i === count - 1) {
      const { item } = await mergedPullDelivered(world, c.connected.repo, { author: who });
      c.refs.push(`pr:${c.connected.repo.id}#${item.number}`);
    } else {
      const { item } = await closedIssueDelivered(world, c.connected.repo, {
        author: who,
        assignees: [who],
      });
      c.refs.push(`issue:${c.connected.repo.id}#${item.number}`);
    }
  }
}

/**
 * Builds the team that meets FR-WORK-13: three members, a linked public repository with enough commits
 * from two members, stage 1 and 2 done and closed, the release link saved on stage 3, 10 contributions on
 * three days, 14+ days since the project started, stage 3 closed. The world needs a FakeClock, the GitHub
 * double and a link checker that answers 200.
 */
export async function completableTeam(
  world: World,
  options: CompletableOptions = {},
): Promise<CompletableTeam> {
  const clock = clockOf(world);
  const fx = await routeTeam(world);
  const connected = await connectRepository(world, fx.team, [fx.backend, fx.frontend], {
    repo: { createdAt: clock.now().toISOString() },
  });
  const built: CompletableTeam = {
    fx,
    connected,
    backend: await ghPerson(world, fx.backend),
    frontend: await ghPerson(world, fx.frontend),
    refs: [],
  };
  const [day0, day1, day2] = options.perDay ?? [4, 3, 3];
  const single = options.singleAuthor ?? false;
  await workDay(world, built, day0, single);
  await completeStageOne(fx);
  await advanceStage(fx, 1);
  await workDay(world, built, day1, single);
  await completeStageTwo(fx);
  await advanceStage(fx, 2);
  await workDay(world, built, day2, single);
  await doneWithLink(fx, 'mini_final_links', fx.frontend, 3, RELEASE_URL);
  clock.advance((options.daysBeforeFinish ?? MIN_PROJECT_DAYS) * DAY);
  if (!options.keepLastStageOpen) await advanceStage(fx, 3);
  return built;
}

/** A started team on the mini playbook with a linked repository and no work yet. */
export async function linkedTeam(
  world: World,
): Promise<{ fx: RouteFixture; connected: Connected }> {
  const fx = await routeTeam(world);
  const connected = await connectRepository(world, fx.team, [fx.backend, fx.frontend]);
  return { fx, connected };
}

/** `completeProject` answered 201 with the snapshot summary. */
export async function completeOk(world: World, c: CompletableTeam): Promise<CompletionDto> {
  await runCheck(world, c.fx.lead, c.fx.team.id);
  const response = await complete(world, c.fx.lead, c.fx.team.id);
  expect(response.statusCode, response.body).toBe(201);
  return expectOk<CompletionDto>('completeProject', response, 201);
}
