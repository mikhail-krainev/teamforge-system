'use client';

import { useInfiniteQuery, useQuery } from '@tanstack/react-query';
import { availableKey, fetchAvailablePage, fetchRepository, repositoryKey } from './api';

export function useRepository(teamId: string) {
  return useQuery({ queryKey: repositoryKey(teamId), queryFn: () => fetchRepository(teamId) });
}

/** Repositories of the installation the lead was just sent back from; read from GitHub each time. */
export function useAvailableRepositories(teamId: string, installationId: number | null) {
  return useInfiniteQuery({
    queryKey: availableKey(teamId, installationId ?? 0),
    enabled: installationId !== null,
    queryFn: ({ pageParam }) => fetchAvailablePage(teamId, installationId ?? 0, pageParam),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last) => last.nextCursor ?? undefined,
    retry: false,
  });
}
