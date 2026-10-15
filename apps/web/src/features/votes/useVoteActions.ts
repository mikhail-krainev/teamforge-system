'use client';

import { useQueryClient } from '@tanstack/react-query';
import { teamEventsKey, teamKey } from '@/features/teams/api';
import { useIdempotentMutation } from '@/lib/api/idempotency';
import {
  castBallot,
  consent,
  nominate,
  requestVote,
  respondOffer,
  returnAsLead,
  voteRequestsKey,
  votesKey,
  withdraw,
} from './api';

/**
 * Every vote action re-reads the vote afterwards: the phase may have changed under the user's
 * hands (a deadline passed, someone else closed the ballot), and the fresh state explains why.
 */
export function useVoteActions(teamId: string, voteId: string) {
  const queryClient = useQueryClient();
  const ref = { teamId, voteId };
  const refresh = async () => {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: votesKey(teamId) }),
      queryClient.invalidateQueries({ queryKey: teamKey(teamId) }),
      queryClient.invalidateQueries({ queryKey: teamEventsKey(teamId) }),
    ]);
  };
  const options = { onSuccess: refresh, onError: refresh };
  const nominateUser = useIdempotentMutation({
    mutationFn: (userId: string, key) => nominate(ref, userId, key),
    ...options,
  });
  const consentSelf = useIdempotentMutation({
    mutationFn: (userId: string, key) => consent(ref, userId, key),
    ...options,
  });
  const withdrawSelf = useIdempotentMutation({
    mutationFn: (_: void, key) => withdraw(ref, key),
    ...options,
  });
  const ballot = useIdempotentMutation({
    mutationFn: (candidateUserId: string, key) => castBallot(ref, candidateUserId, key),
    ...options,
  });
  const respond = useIdempotentMutation({
    mutationFn: (accept: boolean, key) => respondOffer(ref, accept, key),
    ...options,
  });
  const all = [nominateUser, consentSelf, withdrawSelf, ballot, respond];
  return {
    nominateUser,
    consentSelf,
    withdrawSelf,
    ballot,
    respond,
    busy: all.some((m) => m.isPending),
    error: all.find((m) => m.isError)?.error ?? null,
  };
}

/** The inactive lead cancels the vote that his silence opened; the vote and the team are re-read. */
export function useReturnAsLead(teamId: string, voteId: string) {
  const queryClient = useQueryClient();
  const refresh = async () => {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: votesKey(teamId) }),
      queryClient.invalidateQueries({ queryKey: teamKey(teamId) }),
      queryClient.invalidateQueries({ queryKey: teamEventsKey(teamId) }),
    ]);
  };
  return useIdempotentMutation({
    mutationFn: (_: void, key) => returnAsLead({ teamId, voteId }, key),
    onSuccess: refresh,
    onError: refresh,
  });
}

export function useRequestVote(teamId: string) {
  const queryClient = useQueryClient();
  return useIdempotentMutation({
    mutationFn: (_: void, key) => requestVote(teamId, key),
    onSettled: async () => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: voteRequestsKey(teamId) }),
        queryClient.invalidateQueries({ queryKey: votesKey(teamId) }),
        queryClient.invalidateQueries({ queryKey: teamKey(teamId) }),
      ]);
    },
  });
}
