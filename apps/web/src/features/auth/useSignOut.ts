'use client';

import { useMutation } from '@tanstack/react-query';
import { useRouter } from 'next/navigation';
import { apiClient } from '@/lib/api/client';
import { useResetSession } from './session';

/** `signOut`, then drops every cached query so nothing of the previous user stays in memory. */
export function useSignOut() {
  const router = useRouter();
  const reset = useResetSession();
  return useMutation({
    mutationFn: async () => {
      await apiClient.POST('/auth/sign-out');
    },
    onSuccess: () => {
      reset();
      router.replace('/sign-in');
      router.refresh();
    },
  });
}
