import type { Schema } from 'shared';
import { apiClient } from '@/lib/api/client';
import { ApiError } from '@/lib/api/errors';

export type RepositoryLink = Schema<'RepositoryLink'>;
export type AvailableRepository = Schema<'AvailableRepository'>;

type Client = typeof apiClient;

export const REPOSITORIES_PAGE_SIZE = 50;

export const githubRootKey = (teamId: string) => ['github', teamId] as const;
export const repositoryKey = (teamId: string) => ['github', teamId, 'repository'] as const;
export const availableKey = (teamId: string, installationId: number) =>
  ['github', teamId, 'available', installationId] as const;

/** The repository bound to the team, or `null` when none is bound (404 of this single resource). */
export async function fetchRepository(
  teamId: string,
  client: Pick<Client, 'GET'> = apiClient,
): Promise<RepositoryLink | null> {
  try {
    const { data } = await client.GET('/v1/teams/{teamId}/repository', {
      params: { path: { teamId } },
    });
    return data ?? null;
  } catch (error) {
    if (error instanceof ApiError && error.status === 404) return null;
    throw error;
  }
}

export async function fetchAvailablePage(
  teamId: string,
  installationId: number,
  cursor: string | undefined,
  client: Pick<Client, 'GET'> = apiClient,
) {
  const query = {
    installationId,
    limit: REPOSITORIES_PAGE_SIZE,
    ...(cursor ? { cursor } : {}),
  };
  const { data } = await client.GET('/v1/teams/{teamId}/github/available-repositories', {
    params: { path: { teamId }, query },
  });
  if (!data) throw new Error('Empty available repositories response');
  return data;
}

export async function createInstallationSession(
  teamId: string,
  key: string,
  client: Pick<Client, 'POST'> = apiClient,
) {
  const { data } = await client.POST('/v1/teams/{teamId}/github/installation-sessions', {
    params: { path: { teamId }, header: { 'Idempotency-Key': key } },
  });
  if (!data) throw new Error('Empty installation session response');
  return data;
}

export async function linkRepository(
  teamId: string,
  input: { installationId: number; repositoryId: number },
  key: string,
  client: Pick<Client, 'PUT'> = apiClient,
) {
  const { data } = await client.PUT('/v1/teams/{teamId}/repository', {
    params: { path: { teamId }, header: { 'Idempotency-Key': key } },
    body: input,
  });
  if (!data) throw new Error('Empty repository link response');
  return data;
}

export async function unlinkRepository(
  teamId: string,
  key: string,
  client: Pick<Client, 'DELETE'> = apiClient,
) {
  await client.DELETE('/v1/teams/{teamId}/repository', {
    params: { path: { teamId }, header: { 'Idempotency-Key': key } },
  });
}
