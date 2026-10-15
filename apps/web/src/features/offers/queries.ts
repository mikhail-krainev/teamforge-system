'use client';

import { useInfiniteQuery, useQuery } from '@tanstack/react-query';
import {
  departuresKey,
  fetchDepartures,
  fetchMyOffers,
  fetchTeamOffers,
  MY_OFFERS_KEY,
  teamOffersKey,
} from './api';

export function useMyOffers() {
  return useInfiniteQuery({
    queryKey: MY_OFFERS_KEY,
    queryFn: ({ pageParam }) => fetchMyOffers(pageParam),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last) => last.nextCursor ?? undefined,
  });
}

export function useTeamOffers(teamId: string) {
  return useInfiniteQuery({
    queryKey: teamOffersKey(teamId),
    queryFn: ({ pageParam }) => fetchTeamOffers(teamId, pageParam),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last) => last.nextCursor ?? undefined,
  });
}

export function useDepartures(teamId: string) {
  return useQuery({ queryKey: departuresKey(teamId), queryFn: () => fetchDepartures(teamId) });
}
