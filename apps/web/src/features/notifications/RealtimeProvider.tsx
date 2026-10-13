'use client';

import { useQueryClient } from '@tanstack/react-query';
import { createContext, useContext, useEffect, useState, type ReactNode } from 'react';
import { useMe } from '@/features/auth/session';
import { createInvalidator, RealtimeClient, realtimeUrl } from '@/lib/realtime';
import { keysFor } from './invalidation';

const RealtimeContext = createContext<RealtimeClient | null>(null);

/**
 * One WebSocket per signed-in user: connected while a user is signed in, subscribed to the user
 * channel; team channels are added by `useTeamChannel`. Pages work without it (no live updates).
 */
export function RealtimeProvider({ children }: { children: ReactNode }) {
  const queryClient = useQueryClient();
  const userId = useMe().data?.id;
  const [client] = useState(() => {
    const invalidator = createInvalidator(queryClient, keysFor);
    return new RealtimeClient({
      url: () => realtimeUrl(),
      onSignal: invalidator.onSignal,
      onReconnected: invalidator.onReconnected,
    });
  });

  useEffect(() => {
    if (!userId || typeof WebSocket === 'undefined') return undefined;
    const release = client.subscribe(`user:${userId}`);
    client.start();
    return () => {
      client.stop();
      release();
    };
  }, [client, userId]);

  return <RealtimeContext.Provider value={client}>{children}</RealtimeContext.Provider>;
}

/** Live updates for one team while the component is mounted (members only: the server checks). */
export function useTeamChannel(teamId: string): void {
  const client = useContext(RealtimeContext);
  useEffect(() => client?.subscribe(`team:${teamId}`), [client, teamId]);
}
