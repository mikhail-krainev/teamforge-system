import { expect } from 'vitest';
import type { Schema } from 'shared';
import type { InjectResponse } from '../helpers/http.js';
import { waitFor } from '../helpers/infra.js';
import { countOf } from './assertions.js';
import type { UserFixture } from './index.js';
import { runJobs, type JobOutcome } from './rewards.js';
import { DAY, expectOk } from './teams.js';
import { clockOf } from './workspace.js';
import type { World } from './world.js';

/**
 * Slice 7 fixtures of the peer reviews (FR-PROF-08, SEC-04; S7-07): calls, SQL readers and the jobs that close
 * the window of C-27. ASSUMPTIONS (architecture 5.3 names the jobs, not the payload): `timers` / `review-publish`
 * with data `{ teamId }`; `maintenance` / `review-purge`, `review-eligibility-scan` without data.
 */

export type ReceivedReviewDto = Schema<'ReceivedReview'>;
export type ReceivedReviewPageDto = Schema<'ReceivedReviewPage'>;
export type ReviewSentDto = Schema<'ReviewSent'>;
export type ReviewSentListDto = Schema<'ReviewSentList'>;

/** C-27: reviews are written this long after the completion. */
export const REVIEW_WINDOW_MS = 14 * DAY;

export const REVIEW_TEXT = 'Отвечал на вопросы в тот же день и аккуратно оформлял изменения.';

export function createReview(
  world: World,
  who: UserFixture,
  teamId: string,
  subjectUserId: string,
  text: string = REVIEW_TEXT,
  key?: string,
): Promise<InjectResponse> {
  return world
    .as(who)
    .post(`/v1/teams/${teamId}/reviews`, { subjectUserId, text }, key === undefined ? {} : { idempotencyKey: key });
}

export function receivedReviews(
  world: World,
  who: UserFixture,
  query: Record<string, string | number> = {},
): Promise<InjectResponse> {
  const suffix = Object.keys(query).length
    ? `?${new URLSearchParams(Object.entries(query).map(([k, v]): [string, string] => [k, String(v)])).toString()}`
    : '';
  return world.as(who).get(`/v1/me/reviews${suffix}`);
}

export const receivedOk = async (world: World, who: UserFixture): Promise<ReceivedReviewDto[]> =>
  expectOk<ReceivedReviewPageDto>('listReceivedReviews', await receivedReviews(world, who, { limit: 100 }), 200)
    .items;

export const sentReviews = (world: World, who: UserFixture, teamId: string): Promise<InjectResponse> =>
  world.as(who).get(`/v1/teams/${teamId}/reviews/sent`);

export const sentOk = (world: World, who: UserFixture, teamId: string): Promise<ReviewSentListDto> =>
  sentReviews(world, who, teamId).then((r) => expectOk<ReviewSentListDto>('listSentReviews', r, 200));

/** The review window of the team: `profiles.review_eligibility` is filled from `workspace.project_completed`. */
export async function waitEligibility(world: World, teamId: string, users: UserFixture[]): Promise<void> {
  await waitFor(async () => {
    const [row] = await world.sql<{ n: number }[]>`
      SELECT count(*)::int AS n FROM profiles.review_eligibility WHERE team_id = ${teamId}`;
    return (row?.n ?? 0) >= users.length;
  }, 30_000);
}

/** Time passes beyond the window of C-27 and the publication job of the team runs (n times at once). */
export async function closeWindow(world: World, teamId: string, count = 1): Promise<JobOutcome[]> {
  clockOf(world).advance(REVIEW_WINDOW_MS + 60 * 60_000);
  return runJobs(world, 'timers', 'review-publish', { teamId }, count, teamId);
}

export const runReviewPurge = (world: World): Promise<JobOutcome[]> =>
  runJobs(world, 'maintenance', 'review-purge', {});

export const runEligibilityScan = (world: World): Promise<JobOutcome[]> =>
  runJobs(world, 'maintenance', 'review-eligibility-scan', {});

export interface PeerReviewRow {
  id: string;
  team_id: string;
  subject_user_id: string;
  text: string;
  status: 'pending' | 'published' | 'withheld';
  published_on: string | null;
  sort_key: number;
  purge_after: string | null;
}

export const reviewRows = (world: World, teamId: string): Promise<PeerReviewRow[]> =>
  world.sql<PeerReviewRow[]>`
    SELECT id, team_id, subject_user_id, text, status, published_on::text AS published_on, sort_key,
           purge_after::text AS purge_after
      FROM profiles.peer_review WHERE team_id = ${teamId} ORDER BY id`;

export const reviewCountFor = (world: World, teamId: string, subjectId: string): Promise<number> =>
  countOf(world.sql<{ n: number }[]>`
    SELECT count(*)::int AS n FROM profiles.peer_review WHERE team_id = ${teamId} AND subject_user_id = ${subjectId}`);

export const authorshipCount = (world: World, teamId: string): Promise<number> =>
  countOf(world.sql<{ n: number }[]>`
    SELECT count(*)::int AS n FROM profiles.peer_review_authorship WHERE team_id = ${teamId}`);

export const authorshipOf = (world: World, authorId: string): Promise<number> =>
  countOf(world.sql<{ n: number }[]>`
    SELECT count(*)::int AS n FROM profiles.peer_review_authorship WHERE author_user_id = ${authorId}`);

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

/** SEC-04 (4): a random UUID of version 4, not a time-ordered one. */
export const expectUuidV4 = (id: string): void => {
  expect(id).toMatch(UUID_V4);
};
