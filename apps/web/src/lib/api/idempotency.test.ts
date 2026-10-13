// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, cleanup, renderHook } from '@testing-library/react';
import { createElement, type ReactNode } from 'react';
import { afterEach, describe, expect, it } from 'vitest';
import { ApiError, NetworkError } from './errors';
import { shouldKeepKey, useIdempotentMutation } from './idempotency';

afterEach(cleanup);

function setup(outcomes: unknown[]) {
  const keys: string[] = [];
  const client = new QueryClient({ defaultOptions: { mutations: { retry: false } } });
  const wrapper = ({ children }: { children: ReactNode }) =>
    createElement(QueryClientProvider, { client }, children);
  const hook = renderHook(
    () =>
      useIdempotentMutation({
        mutationFn: async (vars: { name: string }, key: string) => {
          keys.push(key);
          const outcome = outcomes.shift();
          if (outcome instanceof Error) throw outcome;
          return vars.name;
        },
      }),
    { wrapper },
  );
  const press = async (name = 'a') => {
    await act(async () => {
      await hook.result.current.mutateAsync({ name }).catch(() => undefined);
    });
  };
  return { keys, press };
}

const apiError = (status: number, code?: string) =>
  new ApiError({
    status,
    body: undefined,
    problem: code ? ({ code, status } as never) : undefined,
  });

describe('useIdempotentMutation', () => {
  it('resets the key after a 4xx response', async () => {
    const { keys, press } = setup([apiError(422, 'VALIDATION_FAILED'), 'ok']);
    await press();
    await press();
    expect(keys).toHaveLength(2);
    expect(keys[0]).not.toBe(keys[1]);
  });

  it.each([
    ['network error', new NetworkError()],
    ['429', apiError(429, 'RATE_LIMITED')],
    ['503', apiError(503)],
    ['500', apiError(500, 'INTERNAL')],
    ['409 in progress', apiError(409, 'IDEMPOTENCY_IN_PROGRESS')],
  ])('keeps the key after %s', async (_name, error) => {
    const { keys, press } = setup([error, 'ok']);
    await press();
    await press();
    expect(keys[0]).toBe(keys[1]);
  });

  it('uses a new key after success', async () => {
    const { keys, press } = setup(['ok', 'ok']);
    await press();
    await press();
    expect(keys[0]).not.toBe(keys[1]);
  });

  it('uses a new key when the input changed after a network error', async () => {
    const { keys, press } = setup([new NetworkError(), 'ok']);
    await press('a');
    await press('b');
    expect(keys[0]).not.toBe(keys[1]);
  });
});

describe('a second identical call while one is in flight', () => {
  it('joins it: one request, one key', async () => {
    const keys: string[] = [];
    const client = new QueryClient({ defaultOptions: { mutations: { retry: false } } });
    const wrapper = ({ children }: { children: ReactNode }) =>
      createElement(QueryClientProvider, { client }, children);
    const hook = renderHook(
      () =>
        useIdempotentMutation({
          mutationFn: async (vars: { name: string }, key: string) => {
            keys.push(key);
            await new Promise((resolve) => setTimeout(resolve, 20));
            return vars.name;
          },
        }),
      { wrapper },
    );
    await act(async () => {
      await Promise.all([
        hook.result.current.mutateAsync({ name: 'a' }),
        hook.result.current.mutateAsync({ name: 'a' }),
      ]);
    });
    expect(keys).toHaveLength(1);
  });

  it('does not join a call with different input', async () => {
    const keys: string[] = [];
    const client = new QueryClient({ defaultOptions: { mutations: { retry: false } } });
    const wrapper = ({ children }: { children: ReactNode }) =>
      createElement(QueryClientProvider, { client }, children);
    const hook = renderHook(
      () =>
        useIdempotentMutation({
          mutationFn: async (vars: { name: string }, key: string) => {
            keys.push(key);
            await new Promise((resolve) => setTimeout(resolve, 20));
            return vars.name;
          },
        }),
      { wrapper },
    );
    await act(async () => {
      await Promise.all([
        hook.result.current.mutateAsync({ name: 'a' }),
        hook.result.current.mutateAsync({ name: 'b' }),
      ]);
    });
    expect(keys).toHaveLength(2);
    expect(keys[0]).not.toBe(keys[1]);
  });
});

describe('shouldKeepKey', () => {
  it('rejects plain errors and ordinary 4xx', () => {
    expect(shouldKeepKey(new Error('x'))).toBe(false);
    expect(shouldKeepKey(apiError(409, 'VERSION_CONFLICT'))).toBe(false);
    expect(shouldKeepKey(apiError(403, 'FORBIDDEN'))).toBe(false);
  });
});
