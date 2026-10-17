'use client';

import { useQueryClient } from '@tanstack/react-query';
import { useIdempotentMutation } from '@/lib/api/idempotency';
import {
  APPLICATION_KEY,
  DEMAND_ROOT,
  cancelApplication,
  createApplication,
  updateApplication,
  type ApplicationRole,
  type SearchApplication,
} from './api';

interface UpdateVars {
  roles: ApplicationRole[];
  version: number;
}

/** Create / update / cancel of the queue application; each keeps its own idempotency key. */
export function useApplicationActions(onCancelled?: () => void) {
  const queryClient = useQueryClient();
  const store = (application: SearchApplication | null) => {
    queryClient.setQueryData(APPLICATION_KEY, application);
    // The queue size and the recommendations depend on the application.
    void queryClient.invalidateQueries({ queryKey: DEMAND_ROOT });
    void queryClient.invalidateQueries({ queryKey: ['recommendations'] });
  };
  const create = useIdempotentMutation({
    mutationFn: (roles: ApplicationRole[], key) => createApplication(roles, key),
    onSuccess: store,
    // Lost race (APPLICATION_EXISTS): show the stored application.
    onError: () => queryClient.invalidateQueries({ queryKey: APPLICATION_KEY }),
  });
  const update = useIdempotentMutation({
    mutationFn: (vars: UpdateVars, key) => updateApplication(vars, key),
    onSuccess: store,
  });
  const cancel = useIdempotentMutation({
    mutationFn: (_: void, key) => cancelApplication(key),
    onSuccess: () => {
      store(null);
      onCancelled?.();
    },
    onError: () => queryClient.invalidateQueries({ queryKey: APPLICATION_KEY }),
  });
  return { create, update, cancel };
}
