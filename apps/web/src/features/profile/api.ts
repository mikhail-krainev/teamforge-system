import type { Schema } from 'shared';
import { apiClient } from '@/lib/api/client';
import { ApiError } from '@/lib/api/errors';
import type { Profile, ProfileInput } from './model';

export type CatalogEntry = Schema<'CatalogEntry'>;

export const PROFILE_KEY = ['profile', 'me'] as const;
export const ROLES_KEY = ['catalog', 'roles'] as const;
export const STACK_KEY = ['catalog', 'stack-tags'] as const;

const MAX_STACK_PAGES = 20;

/** `getMyProfile`; `null` while the profile has never been saved (404). */
export async function fetchMyProfile(
  client: Pick<typeof apiClient, 'GET'> = apiClient,
): Promise<Profile | null> {
  try {
    const { data } = await client.GET('/v1/me/profile');
    return data ?? null;
  } catch (error) {
    if (error instanceof ApiError && error.status === 404) return null;
    throw error;
  }
}

export async function saveMyProfile(
  input: ProfileInput,
  idempotencyKey: string,
  client: Pick<typeof apiClient, 'PUT'> = apiClient,
): Promise<Profile> {
  const { data } = await client.PUT('/v1/me/profile', {
    body: input,
    params: { header: { 'Idempotency-Key': idempotencyKey } },
  });
  if (!data) throw new Error('Empty profile response');
  return data;
}

export async function fetchRoles(
  client: Pick<typeof apiClient, 'GET'> = apiClient,
): Promise<CatalogEntry[]> {
  const { data } = await client.GET('/v1/catalog/roles', { params: { query: {} } });
  return data?.items ?? [];
}

/** All active stack tags: follows `nextCursor` (bounded, so a faulty server cannot loop forever). */
export async function fetchStackTags(
  client: Pick<typeof apiClient, 'GET'> = apiClient,
): Promise<CatalogEntry[]> {
  const items: CatalogEntry[] = [];
  let cursor: string | undefined;
  for (let page = 0; page < MAX_STACK_PAGES; page += 1) {
    const { data } = await client.GET('/v1/catalog/stack-tags', {
      params: { query: cursor ? { cursor } : {} },
    });
    if (!data) break;
    items.push(...data.items);
    if (!data.nextCursor) break;
    cursor = data.nextCursor;
  }
  return items;
}
