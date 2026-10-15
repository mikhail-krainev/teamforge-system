'use client';

import { useQueryClient } from '@tanstack/react-query';
import { teamKey } from '@/features/teams/api';
import { useIdempotentMutation } from '@/lib/api/idempotency';
import { acceptOffer, MY_OFFERS_KEY, rejectOffer, teamOffersKey, type SeatOffer } from './api';

/**
 * Accept / reject of one offer. Each button owns its idempotency key (one per intent): a retry after
 * a network failure reuses it, a definite answer (409, 410...) makes the next click a new intent.
 */
export function useOfferActions(offer: SeatOffer) {
  const queryClient = useQueryClient();
  const refresh = async () => {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: MY_OFFERS_KEY }),
      queryClient.invalidateQueries({ queryKey: teamOffersKey(offer.teamId) }),
      queryClient.invalidateQueries({ queryKey: teamKey(offer.teamId) }),
    ]);
  };
  const accept = useIdempotentMutation({
    mutationFn: (_: void, key) => acceptOffer(offer.id, key),
    onSuccess: refresh,
    // A lost race (SEAT_TAKEN, TEAM_FULL, ...) changes the offer too: show its fresh status.
    onError: refresh,
  });
  const reject = useIdempotentMutation({
    mutationFn: (_: void, key) => rejectOffer(offer.id, key),
    onSuccess: refresh,
  });
  return { accept, reject, busy: accept.isPending || reject.isPending, refresh };
}
