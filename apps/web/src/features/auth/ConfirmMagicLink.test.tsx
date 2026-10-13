// @vitest-environment jsdom
import { QueryClientProvider } from '@tanstack/react-query';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { StrictMode } from 'react';
import { HttpResponse, http } from 'msw';
import { setupServer } from 'msw/node';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { makeQueryClient } from '@/app/providers';
import { problem } from '@/mocks/slice2/handlers';
import { ConfirmMagicLink } from './ConfirmMagicLink';

const replace = vi.fn();
vi.mock('next/navigation', () => ({ useRouter: () => ({ replace }) }));
vi.mock('@/lib/api/client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/api/client')>();
  return { ...actual, apiClient: actual.createApiClient({ baseUrl: 'http://localhost/api' }) };
});

const CONFIRM_URL = 'http://localhost/api/auth/magic-link/confirm';
const TOKEN = 'good0123456789abcdef';
const server = setupServer();
beforeAll(() => server.listen({ onUnhandledFrame: 'error' }));
beforeEach(() => replace.mockClear());
afterEach(() => {
  cleanup();
  server.resetHandlers();
  window.history.replaceState(null, '', '/');
});
afterAll(() => server.close());

function open(hash: string) {
  window.history.replaceState(null, '', `/auth/confirm${hash}`);
  render(
    <StrictMode>
      <QueryClientProvider client={makeQueryClient()}>
        <ConfirmMagicLink />
      </QueryClientProvider>
    </StrictMode>,
  );
}

describe('ConfirmMagicLink', () => {
  it('posts the fragment token once, removes it from the URL and redirects', async () => {
    const seen: Array<{ url: string; body: unknown }> = [];
    server.use(
      http.post(CONFIRM_URL, async ({ request }) => {
        seen.push({ url: request.url, body: await request.json() });
        return HttpResponse.json({ redirectTo: '/profile' });
      }),
    );
    open(`#token=${TOKEN}`);
    await waitFor(() => expect(replace).toHaveBeenCalledWith('/profile'));
    // Under StrictMode (effects run twice) exactly one POST leaves the browser.
    expect(seen).toEqual([{ url: CONFIRM_URL, body: { token: TOKEN } }]);
    expect(window.location.hash).toBe('');
    expect(window.location.href).not.toContain(TOKEN);
  });

  it('never follows an unsafe redirectTo', async () => {
    server.use(
      http.post(CONFIRM_URL, () => HttpResponse.json({ redirectTo: 'https://evil.example' })),
    );
    open(`#token=${TOKEN}`);
    await waitFor(() => expect(replace).toHaveBeenCalledWith('/profile'));
  });

  it('explains an expired link and offers a new one without a retry button', async () => {
    server.use(http.post(CONFIRM_URL, () => problem(401, 'EXPIRED_TOKEN')));
    open(`#token=${TOKEN}`);
    expect((await screen.findByRole('alert')).textContent).toContain('Срок действия ссылки истёк');
    expect(screen.getByRole('link', { name: 'Запросить новую ссылку' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Повторить попытку' })).toBeNull();
  });

  it('shows the used-link error for INVALID_TOKEN', async () => {
    server.use(http.post(CONFIRM_URL, () => problem(401, 'INVALID_TOKEN')));
    open(`#token=${TOKEN}`);
    expect((await screen.findByRole('alert')).textContent).toContain('уже использована');
  });

  it('does not call the API when the fragment has no token', async () => {
    let calls = 0;
    server.use(http.post(CONFIRM_URL, () => (calls++, HttpResponse.json({ redirectTo: '/' }))));
    open('');
    expect((await screen.findByRole('alert')).textContent).toContain('нет данных для входа');
    expect(calls).toBe(0);
  });
});
