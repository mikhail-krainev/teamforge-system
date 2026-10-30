'use client';

import { useQuery } from '@tanstack/react-query';
import {
  awardsKey,
  badgesKey,
  countersKey,
  creditKey,
  fetchAwards,
  fetchBadges,
  fetchCounters,
  fetchCredit,
} from './api';

const CATALOG_STALE_MS = 5 * 60_000;

export function useBadges() {
  return useQuery({ queryKey: badgesKey, queryFn: () => fetchBadges(), staleTime: CATALOG_STALE_MS });
}

export function useAwards(userId: string) {
  return useQuery({ queryKey: awardsKey(userId), queryFn: () => fetchAwards(userId) });
}

export function useCounters(userId: string) {
  return useQuery({ queryKey: countersKey(userId), queryFn: () => fetchCounters(userId) });
}

export function useCredit(teamId: string) {
  return useQuery({ queryKey: creditKey(teamId), queryFn: () => fetchCredit(teamId) });
}
