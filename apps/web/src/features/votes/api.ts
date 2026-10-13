import type { Schema } from 'shared';
import { apiClient } from '@/lib/api/client';

export type LeaderVote = Schema<'LeaderVote'>;
export type VoteCandidate = Schema<'VoteCandidate'>;
export type VoteRequestStatus = Schema<'VoteRequestStatus'>;

type Client = typeof apiClient;

export const VOTES_PAGE = 5;
export const votesKey = (teamId: string) => ['votes', teamId] as const;
export const voteRequestsKey = (teamId: string) => ['votes', teamId, 'requests'] as const;

export async function fetchVotes(teamId: string, client: Pick<Client, 'GET'> = apiClient) {
  const { data } = await client.GET('/v1/teams/{teamId}/leader-votes', {
    params: { path: { teamId }, query: { limit: VOTES_PAGE } },
  });
  if (!data) throw new Error('Empty votes response');
  return data.items;
}

export async function fetchVoteRequests(teamId: string, client: Pick<Client, 'GET'> = apiClient) {
  const { data } = await client.GET('/v1/teams/{teamId}/leader-vote-requests', {
    params: { path: { teamId } },
  });
  if (!data) throw new Error('Empty vote requests response');
  return data;
}

export async function requestVote(
  teamId: string,
  key: string,
  client: Pick<Client, 'POST'> = apiClient,
) {
  const { data } = await client.POST('/v1/teams/{teamId}/leader-vote-requests', {
    params: { path: { teamId }, header: { 'Idempotency-Key': key } },
  });
  if (!data) throw new Error('Empty vote request response');
  return data;
}

export interface VoteRef {
  teamId: string;
  voteId: string;
}

export async function nominate(
  { teamId, voteId }: VoteRef,
  userId: string,
  key: string,
  client: Pick<Client, 'POST'> = apiClient,
) {
  const { data } = await client.POST('/v1/teams/{teamId}/leader-votes/{voteId}/candidates', {
    body: { userId },
    params: { path: { teamId, voteId }, header: { 'Idempotency-Key': key } },
  });
  if (!data) throw new Error('Empty vote response');
  return data;
}

export async function consent(
  { teamId, voteId }: VoteRef,
  candidateUserId: string,
  key: string,
  client: Pick<Client, 'POST'> = apiClient,
) {
  const { data } = await client.POST(
    '/v1/teams/{teamId}/leader-votes/{voteId}/candidates/{candidateUserId}/consent',
    { params: { path: { teamId, voteId, candidateUserId }, header: { 'Idempotency-Key': key } } },
  );
  if (!data) throw new Error('Empty vote response');
  return data;
}

export async function withdraw(
  { teamId, voteId }: VoteRef,
  key: string,
  client: Pick<Client, 'POST'> = apiClient,
) {
  const { data } = await client.POST(
    '/v1/teams/{teamId}/leader-votes/{voteId}/candidates/me/withdrawal',
    { params: { path: { teamId, voteId }, header: { 'Idempotency-Key': key } } },
  );
  if (!data) throw new Error('Empty vote response');
  return data;
}

export async function castBallot(
  { teamId, voteId }: VoteRef,
  candidateUserId: string,
  key: string,
  client: Pick<Client, 'POST'> = apiClient,
) {
  const { data } = await client.POST('/v1/teams/{teamId}/leader-votes/{voteId}/ballots', {
    body: { candidateUserId },
    params: { path: { teamId, voteId }, header: { 'Idempotency-Key': key } },
  });
  if (!data) throw new Error('Empty vote response');
  return data;
}

export async function respondOffer(
  { teamId, voteId }: VoteRef,
  accept: boolean,
  key: string,
  client: Pick<Client, 'POST'> = apiClient,
) {
  const { data } = await client.POST('/v1/teams/{teamId}/leader-votes/{voteId}/offer-responses', {
    body: { accept },
    params: { path: { teamId, voteId }, header: { 'Idempotency-Key': key } },
  });
  if (!data) throw new Error('Empty vote response');
  return data;
}
