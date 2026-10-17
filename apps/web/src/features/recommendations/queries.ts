'use client';

import { useInfiniteQuery } from '@tanstack/react-query';
import {
  fetchRecommendedTeams,
  fetchSeatCandidates,
  RECOMMENDED_TEAMS_KEY,
  seatCandidatesKey,
} from './api';

export function useRecommendedTeams() {
  return useInfiniteQuery({
    queryKey: RECOMMENDED_TEAMS_KEY,
    queryFn: ({ pageParam }) => fetchRecommendedTeams(pageParam),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last) => last.nextCursor ?? undefined,
  });
}

export function useSeatCandidates(teamId: string, seatId: string, enabled: boolean) {
  return useInfiniteQuery({
    queryKey: seatCandidatesKey(teamId, seatId),
    queryFn: ({ pageParam }) => fetchSeatCandidates(teamId, seatId, pageParam),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last) => last.nextCursor ?? undefined,
    enabled,
  });
}
