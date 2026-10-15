'use client';

import { useQuery } from '@tanstack/react-query';
import { fetchVoteRequests, fetchVotes, voteRequestsKey, votesKey } from './api';

export function useVotes(teamId: string) {
  return useQuery({ queryKey: votesKey(teamId), queryFn: () => fetchVotes(teamId) });
}

export function useVoteRequests(teamId: string, enabled: boolean) {
  return useQuery({
    queryKey: voteRequestsKey(teamId),
    queryFn: () => fetchVoteRequests(teamId),
    enabled,
  });
}
