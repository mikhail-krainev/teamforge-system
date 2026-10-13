'use client';

import { useQuery, useQueryClient } from '@tanstack/react-query';
import type { Schema } from 'shared';
import { apiClient } from '@/lib/api/client';
import { ApiError } from '@/lib/api/errors';

export type Me = Schema<'Me'>;

export const ME_QUERY_KEY = ['me'] as const;

/** `getMe`; `null` means "not signed in" (401), any other failure is thrown. */
export async function fetchMe(
  client: Pick<typeof apiClient, 'GET'> = apiClient,
): Promise<Me | null> {
  try {
    const { data } = await client.GET('/v1/me');
    return data ?? null;
  } catch (error) {
    if (error instanceof ApiError && error.status === 401) return null;
    throw error;
  }
}

export function useMe() {
  return useQuery({ queryKey: ME_QUERY_KEY, queryFn: () => fetchMe(), staleTime: 60_000 });
}

/**
 * After `requestDeletion` the account is `deleting` and its sessions are being revoked: remember
 * that in the cached `me` (the banner and the settings page read it) and drop everything else that
 * was cached for the user, so no stale profile or resume stays on screen (S2CR-08).
 */
export function useMarkAccountDeleting() {
  const client = useQueryClient();
  return () => {
    client.setQueryData<Me | null>(ME_QUERY_KEY, (me) => (me ? { ...me, status: 'deleting' } : me));
    client.removeQueries({ predicate: (query) => query.queryKey[0] !== ME_QUERY_KEY[0] });
  };
}

/** Forget everything cached for the previous user (after sign-in or sign-out). */
export function useResetSession() {
  const client = useQueryClient();
  return () => {
    client.clear();
  };
}
