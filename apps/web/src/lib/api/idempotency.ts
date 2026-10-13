'use client';

import {
  useMutation,
  type UseMutationOptions,
  type UseMutationResult,
} from '@tanstack/react-query';
import { useRef } from 'react';
import { ApiError, NetworkError } from './errors';
import { newIdempotencyKey } from './uuid';

/**
 * Whether a failed attempt must be retried with the SAME key.
 * The outcome of the first attempt is unknown (network, timeout, 5xx, 429, 503) or the
 * request is still running (409 IDEMPOTENCY_IN_PROGRESS), so a new key could duplicate it.
 * Any other 4xx is a definite answer: the next user action is a new intent with a new key.
 */
export function shouldKeepKey(error: unknown): boolean {
  if (error instanceof NetworkError) return true;
  if (!(error instanceof ApiError)) return false;
  if (error.code === 'IDEMPOTENCY_IN_PROGRESS') return true;
  return error.status === 408 || error.status === 429 || error.status >= 500;
}

function fingerprint(variables: unknown): string {
  try {
    return JSON.stringify(variables) ?? '';
  } catch {
    return newIdempotencyKey(); // unserialisable input never reuses a key
  }
}

type IdempotentOptions<TData, TError, TVariables, TContext> = Omit<
  UseMutationOptions<TData, TError, TVariables, TContext>,
  'mutationFn'
> & { mutationFn: (variables: TVariables, idempotencyKey: string) => Promise<TData> };

/**
 * `useMutation` that owns an `Idempotency-Key`: a new key per user intent, reused
 * only while the previous attempt is inconclusive and the input is unchanged.
 */
export function useIdempotentMutation<
  TData = unknown,
  TError = Error,
  TVariables = void,
  TContext = unknown,
>(
  options: IdempotentOptions<TData, TError, TVariables, TContext>,
): UseMutationResult<TData, TError, TVariables, TContext> {
  const slot = useRef<{ key: string; fingerprint: string } | null>(null);
  // The attempt in flight: a second identical call (a double click that lands before the button
  // is disabled) joins it instead of sending the same request twice.
  const running = useRef<{ fingerprint: string; promise: Promise<TData> } | null>(null);
  const { mutationFn, ...rest } = options;

  async function attempt(variables: TVariables, print: string): Promise<TData> {
    if (slot.current?.fingerprint !== print) {
      slot.current = { key: newIdempotencyKey(), fingerprint: print };
    }
    const key = slot.current.key;
    try {
      const result = await mutationFn(variables, key);
      slot.current = null;
      return result;
    } catch (error) {
      if (!shouldKeepKey(error)) slot.current = null;
      throw error;
    }
  }

  return useMutation<TData, TError, TVariables, TContext>({
    ...rest,
    mutationFn: (variables) => {
      const print = fingerprint(variables);
      if (running.current?.fingerprint === print) return running.current.promise;
      const promise = attempt(variables, print).finally(() => {
        if (running.current?.promise === promise) running.current = null;
      });
      running.current = { fingerprint: print, promise };
      return promise;
    },
  });
}
