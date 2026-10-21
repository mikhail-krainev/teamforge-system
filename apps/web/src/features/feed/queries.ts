'use client';

import { useInfiniteQuery } from '@tanstack/react-query';
import { fetchFeedPage, feedListKey, type FeedFilters } from './api';

/** The feed by cursor; the pages are re-read together when the team records a contribution. */
export function useFeed(teamId: string, filters: FeedFilters) {
  return useInfiniteQuery({
    queryKey: feedListKey(teamId, filters),
    queryFn: ({ pageParam }) => fetchFeedPage(teamId, filters, pageParam),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last) => last.nextCursor ?? undefined,
  });
}
