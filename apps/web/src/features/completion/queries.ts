'use client';

import { useQuery } from '@tanstack/react-query';
import {
  completionKey,
  fetchCompletion,
  fetchLatestCheck,
  latestCheckKey,
  type CompletionCheck,
} from './api';

/** How often a check that has not finished is re-read. */
export const CHECK_POLL_MS = 3000;

export function isCheckInProgress(check: CompletionCheck | null | undefined): boolean {
  return check?.status === 'queued' || check?.status === 'running';
}

export function useLatestCheck(teamId: string) {
  return useQuery({
    queryKey: latestCheckKey(teamId),
    queryFn: () => fetchLatestCheck(teamId),
    refetchInterval: (query) => (isCheckInProgress(query.state.data) ? CHECK_POLL_MS : false),
  });
}

export function useCompletion(teamId: string, enabled: boolean) {
  return useQuery({
    queryKey: completionKey(teamId),
    queryFn: () => fetchCompletion(teamId),
    enabled,
  });
}
