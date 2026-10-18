import type { Schema } from 'shared';
import { apiClient } from '@/lib/api/client';

export type ContributionSummary = Schema<'ContributionSummary'>;
export type MemberContribution = ContributionSummary['members'][number];
export type RoleContribution = MemberContribution['byRole'][number];
export type FeedEntry = Schema<'FeedEntry'>;

type Client = typeof apiClient;

/** Root of the feed and the contribution queries of a team: one prefix refreshes both. */
export const feedRootKey = (teamId: string) => ['feed', teamId] as const;
export const summaryKey = (teamId: string) => ['feed', teamId, 'summary'] as const;

export async function fetchSummary(teamId: string, client: Pick<Client, 'GET'> = apiClient) {
  const { data } = await client.GET('/v1/teams/{teamId}/contributions/summary', {
    params: { path: { teamId } },
  });
  if (!data) throw new Error('Empty contribution summary response');
  return data;
}

export async function relabelContribution(
  teamId: string,
  input: { contributionId: string; roleCode: string },
  key: string,
  client: Pick<Client, 'PATCH'> = apiClient,
) {
  const { data } = await client.PATCH('/v1/teams/{teamId}/contributions/{contributionId}', {
    params: {
      path: { teamId, contributionId: input.contributionId },
      header: { 'Idempotency-Key': key },
    },
    body: { roleCode: input.roleCode },
  });
  if (!data) throw new Error('Empty relabel response');
  return data;
}
