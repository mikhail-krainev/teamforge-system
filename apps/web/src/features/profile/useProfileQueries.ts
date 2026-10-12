'use client';

import { useQuery } from '@tanstack/react-query';
import {
  fetchMyProfile,
  fetchRoles,
  fetchStackTags,
  PROFILE_KEY,
  ROLES_KEY,
  STACK_KEY,
} from './api';

const CATALOG_STALE_MS = 5 * 60_000;

export function useMyProfile() {
  return useQuery({ queryKey: PROFILE_KEY, queryFn: () => fetchMyProfile() });
}

export function useRoles() {
  return useQuery({
    queryKey: ROLES_KEY,
    queryFn: () => fetchRoles(),
    staleTime: CATALOG_STALE_MS,
  });
}

export function useStackTags() {
  return useQuery({
    queryKey: STACK_KEY,
    queryFn: () => fetchStackTags(),
    staleTime: CATALOG_STALE_MS,
  });
}
