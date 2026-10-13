// @vitest-environment jsdom
import { QueryClientProvider } from '@tanstack/react-query';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { HttpResponse, http } from 'msw';
import { setupServer } from 'msw/node';
import { StrictMode } from 'react';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { makeQueryClient } from '@/app/providers';
import { problem } from '@/mocks/slice2/handlers';
import { API } from '@/test/support';
import { CancelDeletion } from './CancelDeletion';

vi.mock('@/lib/api/client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/api/client')>();
  return { ...actual, apiClient: actual.createApiClient({ baseUrl: 'http://localhost/api' }) };
});

const CANCEL_URL = `${API}/v1/deletion-request-cancellations`;
const TOKEN = 'cancel0123456789abcdef';
const server = setupServer();
beforeAll(() => server.listen({ onUnhandledFrame: 'error' }));
afterEach(() => {
  cleanup();
  server.resetHandlers();
  window.history.replaceState(null, '', '/');
});
afterAll(() => server.close());

function open(hash: string) {
  window.history.replaceState(null, '', `/deletion/cancel${hash}`);
  render(
    <StrictMode>
      <QueryClientProvider client={makeQueryClient()}>
        <CancelDeletion />
      </QueryClientProvider>
    </StrictMode>,
  );
}

describe('CancelDeletion', () => {
  it('posts the fragment token exactly once (StrictMode), removes it from the URL and confirms', async () => {
    const bodies: unknown[] = [];
    server.use(
      http.post(CANCEL_URL, async ({ request }) => {
        bodies.push(await request.json());
        return HttpResponse.json({ id: 'r1', status: 'cancelled' });
      }),
    );
    open(`#token=${TOKEN}`);
    expect(await screen.findByText(/Удаление отменено/)).toBeTruthy();
    expect(bodies).toEqual([{ token: TOKEN }]);
    expect(window.location.hash).toBe('');
    expect(screen.getByRole('link', { name: 'Войти' })).toBeTruthy();
  });

  it('410 says the term is over and offers sign-in without a retry button', async () => {
    server.use(http.post(CANCEL_URL, () => problem(410, 'DELETION_CANCEL_GONE')));
    open(`#token=${TOKEN}`);
    expect((await screen.findByRole('alert')).textContent).toContain('Срок отмены истёк');
    expect(screen.queryByRole('button', { name: 'Повторить попытку' })).toBeNull();
    expect(screen.getByRole('link', { name: 'Войти' })).toBeTruthy();
  });

  it('a transient failure can be retried with the same token', async () => {
    let calls = 0;
    server.use(
      http.post(CANCEL_URL, () =>
        ++calls === 1
          ? problem(503, 'INTERNAL')
          : HttpResponse.json({ id: 'r1', status: 'cancelled' }),
      ),
    );
    open(`#token=${TOKEN}`);
    (await screen.findByRole('button', { name: 'Повторить попытку' })).click();
    expect(await screen.findByText(/Удаление отменено/)).toBeTruthy();
    expect(calls).toBe(2);
  });

  it('without a token nothing is sent', async () => {
    let calls = 0;
    server.use(http.post(CANCEL_URL, () => (calls++, HttpResponse.json({}))));
    open('');
    await waitFor(() => expect(screen.getByRole('alert').textContent).toContain('нет данных'));
    expect(calls).toBe(0);
  });
});
