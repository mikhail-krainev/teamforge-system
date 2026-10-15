'use client';

import { useQuery } from '@tanstack/react-query';
import { APPLICATION_KEY, demandKey, fetchDemand, fetchMyApplication } from './api';

export function useMyApplication() {
  return useQuery({ queryKey: APPLICATION_KEY, queryFn: () => fetchMyApplication() });
}

export function useDemand(roles?: readonly string[], enabled = true) {
  return useQuery({
    queryKey: demandKey(roles),
    queryFn: () => fetchDemand(roles),
    enabled,
  });
}
