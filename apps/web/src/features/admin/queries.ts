'use client';

import { useInfiniteQuery, useQuery } from '@tanstack/react-query';
import { useRouter } from 'next/navigation';
import { useEffect } from 'react';
import { useMe } from '@/features/auth/session';
import { caseKey, casesKey, fetchCase, fetchCases, type FraudStatus } from './api';

export function useCases(status: FraudStatus) {
  return useInfiniteQuery({
    queryKey: casesKey(status),
    queryFn: ({ pageParam }) => fetchCases(status, pageParam),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last) => last.nextCursor ?? undefined,
  });
}

export function useCase(caseId: string) {
  return useQuery({ queryKey: caseKey(caseId), queryFn: () => fetchCase(caseId) });
}

/**
 * UX redirect only: the page is for administrators, the api checks the right itself.
 * Returns true once the session is known to be an administrator's.
 */
export function useAdminGuard(): boolean {
  const router = useRouter();
  const me = useMe();
  const denied = me.data !== undefined && !me.data?.isAdmin;
  useEffect(() => {
    if (denied) router.replace('/');
  }, [denied, router]);
  return Boolean(me.data?.isAdmin);
}
