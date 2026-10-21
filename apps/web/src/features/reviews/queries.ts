'use client';

import { useInfiniteQuery, useQuery } from '@tanstack/react-query';
import { fetchTeam, teamKey } from '@/features/teams/api';
import {
  fetchFinishedTeams,
  fetchReceivedPage,
  fetchSent,
  finishedTeamsKey,
  receivedKey,
  sentKey,
} from './api';

export function useFinishedTeams() {
  return useQuery({ queryKey: finishedTeamsKey, queryFn: () => fetchFinishedTeams() });
}

export function useReceivedReviews() {
  return useInfiniteQuery({
    queryKey: receivedKey,
    queryFn: ({ pageParam }) => fetchReceivedPage(pageParam),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last) => last.nextCursor ?? undefined,
  });
}

export function useSentReviews(teamId: string) {
  return useQuery({ queryKey: sentKey(teamId), queryFn: () => fetchSent(teamId) });
}

export function useProjectMembers(teamId: string) {
  return useQuery({ queryKey: teamKey(teamId), queryFn: () => fetchTeam(teamId) });
}
