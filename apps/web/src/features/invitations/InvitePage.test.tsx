// @vitest-environment jsdom
import { cleanup, fireEvent, screen, waitFor } from '@testing-library/react';
import { HttpResponse, http } from 'msw';
import { setupServer } from 'msw/node';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { PRODUCT_TYPES, ROLE_LIST, TEAM_ID } from '@/features/teams/fixtures';
import { problem } from '@/mocks/slice2/handlers';
import { API, renderWithClient } from '@/test/support';
import { InvitePage } from './InvitePage';

vi.mock('@/lib/api/client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/api/client')>();
  return { ...actual, apiClient: actual.createApiClient({ baseUrl: 'http://localhost/api' }) };
});
vi.mock('next/link', () => ({
  default: ({ href, children }: { href: string; children: React.ReactNode }) => (
    <a href={href}>{children}</a>
  ),
}));

const server = setupServer();
beforeAll(() => server.listen({ onUnhandledFrame: 'error' }));
afterEach(() => {
  cleanup();
  server.resetHandlers();
  window.history.replaceState(null, '', '/');
});
afterAll(() => server.close());

const TOKEN = 'abcdefghij0123456789ABCDEFGHIJ-_abcdefghijK';
const PREVIEW = {
  teamId: TEAM_ID,
  teamName: 'Команда Альфа',
  roleCode: 'backend',
  productTypeCode: 'web_service',
  expiresAt: '2026-02-01T10:00:00.000Z',
};
const JOINED = {
  teamId: TEAM_ID,
  seatId: '0192f0a0-7c1e-7b3a-8d2f-00000000b001',
  roleCode: 'backend',
  joinedVia: 'invite',
  trialUntil: null,
  deficitAtJoin: false,
};

function serve(signedIn = true) {
  server.use(
    http.get(`${API}/v1/me`, () =>
      signedIn ? HttpResponse.json({ id: 'u1' }) : problem(401, 'UNAUTHENTICATED'),
    ),
    http.get(`${API}/v1/catalog/roles`, () =>
      HttpResponse.json({ items: ROLE_LIST, nextCursor: null }),
    ),
    http.get(`${API}/v1/product-types`, () => HttpResponse.json({ items: PRODUCT_TYPES })),
  );
}
const withHash = (hash: string) => window.history.replaceState(null, '', `/invite${hash}`);

describe('FR-TEAM-09: InvitePage', () => {
  it('previews first, removes the fragment, then accepts on request', async () => {
    serve();
    withHash(`#${TOKEN}`);
    const bodies: unknown[] = [];
    let key: string | null = null;
    server.use(
      http.post(`${API}/v1/invitation-previews`, async ({ request }) => {
        bodies.push(await request.json());
        return HttpResponse.json(PREVIEW);
      }),
      http.post(`${API}/v1/invitation-acceptances`, async ({ request }) => {
        key = request.headers.get('Idempotency-Key');
        bodies.push(await request.json());
        return HttpResponse.json(JOINED);
      }),
    );
    renderWithClient(<InvitePage />);
    expect(await screen.findByText('Команда Альфа')).toBeTruthy();
    expect(screen.getByRole('heading', { level: 1, name: 'Приглашение в команду' })).toBeTruthy();
    expect(await screen.findByText('Backend-разработчик')).toBeTruthy();
    expect(window.location.hash).toBe('');
    expect(bodies).toEqual([{ token: TOKEN }]);
    fireEvent.click(screen.getByRole('button', { name: 'Принять приглашение' }));
    expect(await screen.findByText('Вы вступили в команду.')).toBeTruthy();
    expect(bodies).toEqual([{ token: TOKEN }, { token: TOKEN }]);
    expect(key).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Перейти в команду' }).getAttribute('href')).toBe(
      `/teams/${TEAM_ID}`,
    );
  });

  it('a missing token explains what to do and sends nothing', async () => {
    serve();
    withHash('');
    renderWithClient(<InvitePage />);
    expect((await screen.findByRole('alert')).textContent).toContain('В ссылке нет приглашения');
  });

  it('410 INVITATION_GONE on preview is a clear Russian message without retry', async () => {
    serve();
    withHash(`#${TOKEN}`);
    server.use(http.post(`${API}/v1/invitation-previews`, () => problem(410, 'INVITATION_GONE')));
    renderWithClient(<InvitePage />);
    expect((await screen.findByRole('alert')).textContent).toContain(
      'Приглашение уже недействительно',
    );
    expect(screen.queryByRole('button', { name: 'Повторить' })).toBeNull();
  });

  it('410 on accept (someone was faster) is announced', async () => {
    serve();
    withHash(`#${TOKEN}`);
    server.use(
      http.post(`${API}/v1/invitation-previews`, () => HttpResponse.json(PREVIEW)),
      http.post(`${API}/v1/invitation-acceptances`, () => problem(410, 'INVITATION_GONE')),
    );
    renderWithClient(<InvitePage />);
    fireEvent.click(await screen.findByRole('button', { name: 'Принять приглашение' }));
    expect((await screen.findByRole('alert')).textContent).toContain('недействительно');
  });

  it('GITHUB_REQUIRED on accept links to GitHub linking; accept retry reuses the key on 503', async () => {
    serve();
    withHash(`#${TOKEN}`);
    const keys: (string | null)[] = [];
    server.use(
      http.post(`${API}/v1/invitation-previews`, () => HttpResponse.json(PREVIEW)),
      http.post(`${API}/v1/invitation-acceptances`, ({ request }) => {
        keys.push(request.headers.get('Idempotency-Key'));
        if (keys.length === 1) return problem(503, 'INTERNAL');
        return problem(409, 'GITHUB_REQUIRED');
      }),
    );
    renderWithClient(<InvitePage />);
    fireEvent.click(await screen.findByRole('button', { name: 'Принять приглашение' }));
    await screen.findByRole('alert');
    fireEvent.click(screen.getByRole('button', { name: 'Принять приглашение' }));
    expect(await screen.findByRole('link', { name: 'Привязать GitHub' })).toBeTruthy();
    await waitFor(() => expect(keys).toHaveLength(2));
    expect(keys[1]).toBe(keys[0]);
  });

  it('a guest is asked to sign in and no preview is requested', async () => {
    serve(false);
    withHash(`#${TOKEN}`);
    renderWithClient(<InvitePage />);
    expect(await screen.findByRole('link', { name: 'Войти' })).toBeTruthy();
    expect(screen.getByText(/войдите в аккаунт/)).toBeTruthy();
  });
});
