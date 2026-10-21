import type { Schema } from 'shared';
import { apiClient } from '@/lib/api/client';
import { ApiError } from '@/lib/api/errors';

export type Completion = Schema<'Completion'>;
export type CompletionCheck = Schema<'CompletionCheck'>;
export type CompletionCheckResult = Schema<'CompletionCheckResult'>;

type Client = typeof apiClient;

// All under the workspace root, so that stage and completion events refresh them together.
export const latestCheckKey = (teamId: string) =>
  ['workspace', teamId, 'completion-check'] as const;
export const completionKey = (teamId: string) => ['workspace', teamId, 'completion'] as const;

/** The latest check of the team, or `null` if it never asked for one (404 of this resource). */
export async function fetchLatestCheck(
  teamId: string,
  client: Pick<Client, 'GET'> = apiClient,
): Promise<CompletionCheck | null> {
  try {
    const { data } = await client.GET('/v1/teams/{teamId}/completion-checks/latest', {
      params: { path: { teamId } },
    });
    return data ?? null;
  } catch (error) {
    if (error instanceof ApiError && error.status === 404) return null;
    throw error;
  }
}

export async function requestCheck(
  teamId: string,
  key: string,
  client: Pick<Client, 'POST'> = apiClient,
) {
  const { data } = await client.POST('/v1/teams/{teamId}/completion-checks', {
    params: { path: { teamId }, header: { 'Idempotency-Key': key } },
  });
  if (!data) throw new Error('Empty completion check response');
  return data;
}

export async function completeProject(
  teamId: string,
  key: string,
  client: Pick<Client, 'POST'> = apiClient,
) {
  const { data } = await client.POST('/v1/teams/{teamId}/completion', {
    params: { path: { teamId }, header: { 'Idempotency-Key': key } },
  });
  if (!data) throw new Error('Empty completion response');
  return data;
}

export async function fetchCompletion(teamId: string, client: Pick<Client, 'GET'> = apiClient) {
  const { data } = await client.GET('/v1/teams/{teamId}/completion', {
    params: { path: { teamId } },
  });
  if (!data) throw new Error('Empty completion response');
  return data;
}
