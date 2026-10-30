// @vitest-environment jsdom
import { useQuery } from '@tanstack/react-query';
import { cleanup, fireEvent, screen, waitFor } from '@testing-library/react';
import { HttpResponse, http } from 'msw';
import { setupServer } from 'msw/node';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { apiClient } from '@/lib/api/client';
import { CONSENT_HASH, MOCK_USER_ID } from '@/mocks/slice2/db';
import { problem } from '@/mocks/slice2/handlers';
import { API, renderWithClient } from '@/test/support';
import { ConsentGate } from './ConsentGate';
import type { Me } from './session';

const replace = vi.fn();
vi.mock('next/navigation', () => ({
  useRouter: () => ({ replace, refresh: vi.fn() }),
  usePathname: () => '/profile',
}));
vi.mock('@/lib/api/client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/api/client')>();
  return { ...actual, apiClient: actual.createApiClient({ baseUrl: 'http://localhost/api' }) };
});

const server = setupServer();
beforeAll(() => server.listen({ onUnhandledFrame: 'error' }));
afterEach(() => {
  cleanup();
  server.resetHandlers();
  replace.mockClear();
});
afterAll(() => server.close());

const me = (overrides: Partial<Me> = {}): Me => ({
  id: MOCK_USER_ID,
  status: 'active',
  github: { linked: false },
  consentRequired: false,
  isAdmin: false,
  locale: 'ru',
  ...overrides,
});

/** A page of the app: it reads something from the API, like every real page does. */
function Page() {
  const data = useQuery({
    queryKey: ['page-data'],
    queryFn: async () => (await apiClient.GET('/v1/me/profile')).data,
  });
  return <p>{data.isError ? 'Страница: ошибка' : 'Страница'}</p>;
}

const renderGate = () =>
  renderWithClient(
    <ConsentGate>
      <Page />
    </ConsentGate>,
  );

describe('ConsentGate', () => {
  it('lets a signed-in user through', async () => {
    server.use(
      http.get(`${API}/v1/me`, () => HttpResponse.json(me())),
      http.get(`${API}/v1/me/profile`, () => problem(404, 'NOT_FOUND')),
    );
    renderGate();
    expect(await screen.findByText(/Страница/)).toBeTruthy();
  });

  it('sends a guest to sign-in with the page to come back to', async () => {
    server.use(http.get(`${API}/v1/me`, () => problem(401, 'UNAUTHENTICATED')));
    renderGate();
    await waitFor(() => expect(replace).toHaveBeenCalledWith('/sign-in?next=%2Fprofile'));
  });

  it('S2CR-08: shows a banner while the account waits for deletion', async () => {
    server.use(
      http.get(`${API}/v1/me`, () => HttpResponse.json(me({ status: 'deleting' }))),
      http.get(`${API}/v1/me/profile`, () => problem(404, 'NOT_FOUND')),
    );
    renderGate();
    expect(
      (await screen.findByText(/Запрошено удаление аккаунта/)).getAttribute('class'),
    ).toContain('alert-warn');
    expect(screen.getByText(/Страница/)).toBeTruthy();
  });

  it('S2CR-11: a 401 from any page (the session expired) sends the user to sign-in', async () => {
    let meCalls = 0;
    server.use(
      http.get(`${API}/v1/me`, () =>
        ++meCalls === 1 ? HttpResponse.json(me()) : problem(401, 'UNAUTHENTICATED'),
      ),
      http.get(`${API}/v1/me/profile`, () => problem(401, 'UNAUTHENTICATED')),
    );
    renderGate();
    await waitFor(() => expect(replace).toHaveBeenCalledWith('/sign-in?next=%2Fprofile'));
    expect(meCalls).toBeGreaterThanOrEqual(2);
  });

  it('S2CR-11: a 403 CONSENT_REQUIRED from any page shows the consent screen instead of an error', async () => {
    let meCalls = 0;
    server.use(
      http.get(`${API}/v1/me`, () => HttpResponse.json(me({ consentRequired: ++meCalls > 1 }))),
      http.get(`${API}/v1/me/profile`, () => problem(403, 'CONSENT_REQUIRED')),
      http.get(`${API}/v1/consent/current`, () =>
        HttpResponse.json({
          version: '2026-10',
          textHash: CONSENT_HASH,
          text: 'Текст согласия',
          publishedAt: '2026-10-01T00:00:00.000Z',
        }),
      ),
    );
    renderGate();
    expect(await screen.findByRole('heading', { name: /Согласие на обработку/ })).toBeTruthy();
    expect(screen.queryByText('Страница: ошибка')).toBeNull();
  });

  it('offers a retry when the user cannot be loaded', async () => {
    let calls = 0;
    server.use(
      http.get(`${API}/v1/me`, () =>
        ++calls === 1 ? problem(403, 'FORBIDDEN') : HttpResponse.json(me()),
      ),
      http.get(`${API}/v1/me/profile`, () => problem(404, 'NOT_FOUND')),
    );
    renderGate();
    fireEvent.click(await screen.findByRole('button', { name: 'Повторить' }));
    expect(await screen.findByText(/Страница/)).toBeTruthy();
  });
});
