import type { Schema } from 'shared';
import { apiClient } from '@/lib/api/client';
import { ApiError } from '@/lib/api/errors';

export type ReceivedReview = Schema<'ReceivedReview'>;
export type ReviewSentList = Schema<'ReviewSentList'>;
export type MyTeam = Schema<'MyTeam'>;

type Client = typeof apiClient;

export const PAGE_SIZE = 20;
export const receivedKey = ['reviews', 'received'] as const;
export const sentKey = (teamId: string) => ['reviews', 'sent', teamId] as const;
export const finishedTeamsKey = ['reviews', 'finished-teams'] as const;

export async function fetchReceivedPage(
  cursor: string | undefined,
  client: Pick<Client, 'GET'> = apiClient,
) {
  const { data } = await client.GET('/v1/me/reviews', {
    params: { query: { limit: PAGE_SIZE, ...(cursor ? { cursor } : {}) } },
  });
  if (!data) throw new Error('Empty reviews response');
  return data;
}

/** The sent list of a project; `null` when the user has no right to review there (404). */
export async function fetchSent(
  teamId: string,
  client: Pick<Client, 'GET'> = apiClient,
): Promise<ReviewSentList | null> {
  try {
    const { data } = await client.GET('/v1/teams/{teamId}/reviews/sent', {
      params: { path: { teamId } },
    });
    return data ?? null;
  } catch (error) {
    if (error instanceof ApiError && error.status === 404) return null;
    throw error;
  }
}

export async function createReview(
  teamId: string,
  input: { subjectUserId: string; text: string },
  key: string,
  client: Pick<Client, 'POST'> = apiClient,
) {
  const { data } = await client.POST('/v1/teams/{teamId}/reviews', {
    params: { path: { teamId }, header: { 'Idempotency-Key': key } },
    body: input,
  });
  if (!data) throw new Error('Empty review response');
  return data;
}

/** The finished projects the user took part in (the ones a review can be left for). */
export async function fetchFinishedTeams(client: Pick<Client, 'GET'> = apiClient) {
  const { data } = await client.GET('/v1/me/teams', {
    params: { query: { status: 'past', limit: 100 } },
  });
  return (data?.items ?? []).filter(
    (item) =>
      item.membershipStatus === 'active' &&
      (item.team.status === 'completed' || item.team.status === 'archived'),
  );
}
