import type { Schema } from 'shared';
import { apiClient } from '@/lib/api/client';

export type Badge = Schema<'Badge'>;
export type Award = Schema<'Award'>;
export type Counters = Schema<'Counters'>;
export type CreditStatus = Schema<'CreditStatus'>;
export type CreditRow = CreditStatus['myCredits'][number];

type Client = typeof apiClient;

export const badgesKey = ['rewards', 'badges'] as const;
export const awardsKey = (userId: string) => ['rewards', 'awards', userId] as const;
export const countersKey = (userId: string) => ['rewards', 'counters', userId] as const;
export const creditKey = (teamId: string) => ['rewards', 'credit', teamId] as const;

export async function fetchBadges(client: Pick<Client, 'GET'> = apiClient) {
  const { data } = await client.GET('/v1/badges');
  return data?.items ?? [];
}

export async function fetchAwards(userId: string, client: Pick<Client, 'GET'> = apiClient) {
  const { data } = await client.GET('/v1/users/{userId}/awards', { params: { path: { userId } } });
  return data?.items ?? [];
}

export async function fetchCounters(userId: string, client: Pick<Client, 'GET'> = apiClient) {
  const { data } = await client.GET('/v1/users/{userId}/counters', {
    params: { path: { userId } },
  });
  if (!data) throw new Error('Empty counters response');
  return data;
}

export async function fetchCredit(teamId: string, client: Pick<Client, 'GET'> = apiClient) {
  const { data } = await client.GET('/v1/teams/{teamId}/credit', { params: { path: { teamId } } });
  if (!data) throw new Error('Empty credit response');
  return data;
}

export async function fileDispute(
  teamId: string,
  text: string,
  key: string,
  client: Pick<Client, 'POST'> = apiClient,
) {
  const { data } = await client.POST('/v1/teams/{teamId}/disputes', {
    params: { path: { teamId }, header: { 'Idempotency-Key': key } },
    body: { text },
  });
  if (!data) throw new Error('Empty dispute response');
  return data;
}
