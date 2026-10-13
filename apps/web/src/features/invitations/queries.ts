'use client';

import { useInfiniteQuery } from '@tanstack/react-query';
import { fetchInvitations, invitationsKey } from './api';

export function useInvitations(teamId: string) {
  return useInfiniteQuery({
    queryKey: invitationsKey(teamId),
    queryFn: ({ pageParam }) => fetchInvitations(teamId, pageParam),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last) => last.nextCursor ?? undefined,
  });
}
