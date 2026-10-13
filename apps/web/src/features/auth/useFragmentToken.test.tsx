// @vitest-environment jsdom
import { cleanup, renderHook, waitFor } from '@testing-library/react';
import { StrictMode } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { useFragmentToken } from './useFragmentToken';

const TOKEN = 'good0123456789abcdef';

afterEach(() => {
  cleanup();
  window.history.replaceState(null, '', '/');
});

function open(hash: string, submit = vi.fn()) {
  window.history.replaceState(null, '', `/auth/confirm${hash}`);
  const hook = renderHook(() => useFragmentToken(submit), { wrapper: StrictMode });
  return { submit, hook };
}

describe('useFragmentToken', () => {
  it('reads the token once, strips the fragment and submits exactly once under StrictMode', async () => {
    const { submit, hook } = open(`#token=${TOKEN}`);
    await waitFor(() => expect(hook.result.current).toBe(TOKEN));
    expect(submit).toHaveBeenCalledTimes(1);
    expect(submit).toHaveBeenCalledWith(TOKEN);
    expect(window.location.hash).toBe('');
    expect(window.location.pathname).toBe('/auth/confirm');
  });

  it.each([
    ['no fragment', ''],
    ['a short token', '#token=abc'],
    ['bad characters', '#token=<script>alert(1)</script>'],
  ])('returns null and submits nothing for %s', async (_name, hash) => {
    const { submit, hook } = open(hash);
    await waitFor(() => expect(hook.result.current).toBeNull());
    expect(submit).not.toHaveBeenCalled();
  });

  it('keeps the query string when it removes the fragment', async () => {
    window.history.replaceState(null, '', `/deletion/cancel?x=1#token=${TOKEN}`);
    const submit = vi.fn();
    renderHook(() => useFragmentToken(submit), { wrapper: StrictMode });
    await waitFor(() => expect(submit).toHaveBeenCalled());
    expect(window.location.search).toBe('?x=1');
    expect(window.location.hash).toBe('');
  });
});
