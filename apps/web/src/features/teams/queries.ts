'use client';

import { useInfiniteQuery, useQuery } from '@tanstack/react-query';
import {
  fetchProductTypes,
  fetchTeam,
  fetchTeamEvents,
  fetchTeamsPage,
  PRODUCT_TYPES_KEY,
  teamEventsKey,
  teamKey,
  teamsListKey,
  type TeamFilters,
} from './api';

const CATALOG_STALE_MS = 5 * 60_000;

export function useProductTypes() {
  return useQuery({
    queryKey: PRODUCT_TYPES_KEY,
    queryFn: () => fetchProductTypes(),
    staleTime: CATALOG_STALE_MS,
  });
}

export function useTeamsList(filters: TeamFilters) {
  return useInfiniteQuery({
    queryKey: teamsListKey(filters),
    queryFn: ({ pageParam }) => fetchTeamsPage(filters, pageParam),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last) => last.nextCursor ?? undefined,
  });
}

export function useTeam(teamId: string) {
  return useQuery({ queryKey: teamKey(teamId), queryFn: () => fetchTeam(teamId) });
}

export function useTeamEvents(teamId: string) {
  return useInfiniteQuery({
    queryKey: teamEventsKey(teamId),
    queryFn: ({ pageParam }) => fetchTeamEvents(teamId, pageParam),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last) => last.nextCursor ?? undefined,
  });
}
