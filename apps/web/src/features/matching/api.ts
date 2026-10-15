import type { Schema } from 'shared';
import { apiClient } from '@/lib/api/client';
import { ApiError } from '@/lib/api/errors';

export type SearchApplication = Schema<'SearchApplication'>;
export type ApplicationRole = Schema<'ApplicationRole'>;
export type RoleDemand = Schema<'RoleDemand'>;

type Client = typeof apiClient;

export const APPLICATION_KEY = ['applications', 'mine'] as const;
export const DEMAND_ROOT = ['demand'] as const;
export const demandKey = (roles: readonly string[] | undefined) =>
  ['demand', roles ?? 'mine'] as const;

export const MAX_APPLICATION_ROLES = 5;

/** `getMySearchApplication`; `null` while there is no active application (404). */
export async function fetchMyApplication(
  client: Pick<Client, 'GET'> = apiClient,
): Promise<SearchApplication | null> {
  try {
    const { data } = await client.GET('/v1/me/search-application');
    return data ?? null;
  } catch (error) {
    if (error instanceof ApiError && error.status === 404) return null;
    throw error;
  }
}

export async function createApplication(
  roles: readonly ApplicationRole[],
  key: string,
  client: Pick<Client, 'POST'> = apiClient,
) {
  const { data } = await client.POST('/v1/me/search-application', {
    body: { roles: [...roles] },
    params: { header: { 'Idempotency-Key': key } },
  });
  if (!data) throw new Error('Empty application response');
  return data;
}

export async function updateApplication(
  body: { roles: readonly ApplicationRole[]; version: number },
  key: string,
  client: Pick<Client, 'PUT'> = apiClient,
) {
  const { data } = await client.PUT('/v1/me/search-application', {
    body: { roles: [...body.roles], version: body.version },
    params: { header: { 'Idempotency-Key': key } },
  });
  if (!data) throw new Error('Empty application response');
  return data;
}

export async function cancelApplication(key: string, client: Pick<Client, 'DELETE'> = apiClient) {
  await client.DELETE('/v1/me/search-application', {
    params: { header: { 'Idempotency-Key': key } },
  });
}

/** `getRoleDemand`; without `roles` the server answers for the caller's desired roles. */
export async function fetchDemand(
  roles: readonly string[] | undefined,
  client: Pick<Client, 'GET'> = apiClient,
) {
  const { data } = await client.GET('/v1/demand', {
    params: { query: roles ? { roles: [...roles] } : {} },
  });
  if (!data) throw new Error('Empty demand response');
  return data.items;
}
