// @vitest-environment jsdom
import { cleanup, fireEvent, screen, waitFor } from '@testing-library/react';
import { HttpResponse, http } from 'msw';
import { setupServer } from 'msw/node';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { ME_QUERY_KEY, type Me } from '@/features/auth/session';
import { MOCK_USER_ID } from '@/mocks/slice2/db';
import { problem } from '@/mocks/slice2/handlers';
import { API, renderWithClient } from '@/test/support';
import { DeletionSection } from './DeletionSection';

vi.mock('@/lib/api/client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/api/client')>();
  return { ...actual, apiClient: actual.createApiClient({ baseUrl: 'http://localhost/api' }) };
});

const DELETE_URL = `${API}/v1/me/deletion-requests`;
const SCHEDULED = '2026-10-16T10:00:00.000Z';
const server = setupServer();
beforeAll(() => server.listen({ onUnhandledFrame: 'error' }));
afterEach(() => {
  cleanup();
  server.resetHandlers();
});
afterAll(() => server.close());

const me = (status: Me['status'] = 'active'): Me => ({
  id: MOCK_USER_ID,
  status,
  github: { linked: false },
  consentRequired: false,
  isAdmin: false,
  locale: 'ru',
});
const serveMe = (status: Me['status'] = 'active') =>
  server.use(http.get(`${API}/v1/me`, () => HttpResponse.json(me(status))));
const accepted = () =>
  HttpResponse.json(
    {
      id: 'r1',
      status: 'requested',
      requestedAt: SCHEDULED,
      scheduledAt: SCHEDULED,
      deadlineAt: SCHEDULED,
    },
    { status: 202 },
  );

const open = async () =>
  fireEvent.click(await screen.findByRole('button', { name: 'Удалить аккаунт…' }));
const confirm = () => fireEvent.click(screen.getByRole('button', { name: 'Запросить удаление' }));

describe('DeletionSection', () => {
  it('needs the checkbox before anything is sent', async () => {
    serveMe();
    let calls = 0;
    server.use(http.post(DELETE_URL, () => (calls++, accepted())));
    renderWithClient(<DeletionSection />);
    await open();
    confirm();
    expect(screen.getByText('Поставь галочку подтверждения.')).toBeTruthy();
    expect(calls).toBe(0);
  });

  it('S2CR-08: after the request the cached user is marked deleting and stale user data is dropped', async () => {
    serveMe();
    server.use(http.post(DELETE_URL, accepted));
    const { client } = renderWithClient(<DeletionSection />);
    client.setQueryData(['profile', 'me'], { version: 1 });
    await open();
    fireEvent.click(screen.getByRole('checkbox'));
    confirm();
    expect(await screen.findByText('Запрос на удаление принят')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Запросить удаление' })).toBeNull();
    expect((client.getQueryData(ME_QUERY_KEY) as Me).status).toBe('deleting');
    expect(client.getQueryData(['profile', 'me'])).toBeUndefined();
  });

  it('S2CR-08: an account that is already deleting shows the request, not the button (reload, second tab)', async () => {
    serveMe('deleting');
    let calls = 0;
    server.use(http.post(DELETE_URL, () => (calls++, accepted())));
    renderWithClient(<DeletionSection />);
    expect(await screen.findByText('Запрос на удаление принят')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Удалить аккаунт…' })).toBeNull();
    expect(calls).toBe(0);
  });

  it('a double click sends one request', async () => {
    serveMe();
    let calls = 0;
    server.use(http.post(DELETE_URL, () => (calls++, accepted())));
    renderWithClient(<DeletionSection />);
    await open();
    fireEvent.click(screen.getByRole('checkbox'));
    confirm();
    confirm();
    await screen.findByText('Запрос на удаление принят');
    expect(calls).toBe(1);
  });

  it('explains REAUTH_REQUIRED and keeps the form', async () => {
    serveMe();
    server.use(http.post(DELETE_URL, () => problem(403, 'REAUTH_REQUIRED')));
    renderWithClient(<DeletionSection />);
    await open();
    fireEvent.click(screen.getByRole('checkbox'));
    confirm();
    await waitFor(() => expect(screen.getByRole('alert').textContent).toContain('войти заново'));
    expect(screen.getByRole('button', { name: 'Запросить удаление' })).toBeTruthy();
  });
});
