'use client';

import { MutationCache, QueryCache, QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { useState, type ReactNode } from 'react';
import { ME_QUERY_KEY } from '@/features/auth/session';
import { RealtimeProvider } from '@/features/notifications/RealtimeProvider';
import { ApiError } from '@/lib/api/errors';

const MAX_QUERY_RETRIES = 2;

/** Definite client errors (4xx except 408/429) are not retried; transient ones are. */
export function shouldRetryQuery(failureCount: number, error: unknown): boolean {
  if (failureCount >= MAX_QUERY_RETRIES) return false;
  if (error instanceof ApiError && error.status < 500) {
    return error.status === 408 || error.status === 429;
  }
  return true;
}

/** Whether a failure means "the session is gone" or "consent has to be accepted first". */
export function isSessionFailure(error: unknown): boolean {
  if (!(error instanceof ApiError)) return false;
  return (
    (error.status === 401 && error.code === 'UNAUTHENTICATED') ||
    (error.status === 403 && error.code === 'CONSENT_REQUIRED')
  );
}

/**
 * Any query or mutation can learn that the session expired (401 UNAUTHENTICATED) or that a new
 * consent text has to be accepted (403 CONSENT_REQUIRED). Instead of a generic error on the page,
 * the current user is re-read: `ConsentGate` then shows sign-in or the consent screen (S2CR-11).
 */
function reactToSessionFailure(client: QueryClient, error: unknown): void {
  if (isSessionFailure(error)) void client.invalidateQueries({ queryKey: ME_QUERY_KEY });
}

export function makeQueryClient(): QueryClient {
  const client: QueryClient = new QueryClient({
    queryCache: new QueryCache({ onError: (error) => reactToSessionFailure(client, error) }),
    mutationCache: new MutationCache({ onError: (error) => reactToSessionFailure(client, error) }),
    defaultOptions: {
      queries: { retry: shouldRetryQuery, staleTime: 30_000, refetchOnWindowFocus: true },
      mutations: { retry: false },
    },
  });
  return client;
}

export function Providers({ children }: { children: ReactNode }) {
  const [client] = useState(makeQueryClient);
  return (
    <QueryClientProvider client={client}>
      <RealtimeProvider>{children}</RealtimeProvider>
    </QueryClientProvider>
  );
}
