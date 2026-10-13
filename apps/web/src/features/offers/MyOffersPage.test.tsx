// @vitest-environment jsdom
import { cleanup, fireEvent, screen, waitFor } from '@testing-library/react';
import { HttpResponse, http } from 'msw';
import { setupServer } from 'msw/node';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { ROLE_LIST } from '@/features/teams/fixtures';
import { problem } from '@/mocks/slice2/handlers';
import { API, renderWithClient } from '@/test/support';
import { OFFER_ID, sampleOffer } from './fixtures';
import { MyOffersPage } from './MyOffersPage';

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
});
afterAll(() => server.close());

const ACCEPT = `${API}/v1/seat-offers/${OFFER_ID}/acceptance`;
const JOIN = {
  teamId: '0192f0a0-7c1e-7b3a-8d2f-00000000a001',
  seatId: '0192f0a0-7c1e-7b3a-8d2f-00000000b001',
  roleCode: 'backend',
  joinedVia: 'offer',
  trialUntil: null,
  deficitAtJoin: false,
};

function serve(items: unknown[]) {
  server.use(
    http.get(`${API}/v1/catalog/roles`, () =>
      HttpResponse.json({ items: ROLE_LIST, nextCursor: null }),
    ),
    http.get(`${API}/v1/me/seat-offers`, () => HttpResponse.json({ items, nextCursor: null })),
  );
}

describe('FR-TEAM-30: MyOffersPage', () => {
  it('lists incoming offers with accept and reject', async () => {
    serve([sampleOffer()]);
    renderWithClient(<MyOffersPage />);
    expect(await screen.findByRole('heading', { level: 1, name: 'Мои предложения' })).toBeTruthy();
    expect(await screen.findByText(/Backend-разработчик/)).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Принять' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Отклонить' })).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Открыть команду' })).toBeTruthy();
  });

  it('shows an empty state', async () => {
    serve([]);
    renderWithClient(<MyOffersPage />);
    expect(await screen.findByText('Предложений и заявок пока нет.')).toBeTruthy();
  });

  it('accepting joins the team and disables the buttons while pending', async () => {
    serve([sampleOffer()]);
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => (release = resolve));
    let calls = 0;
    server.use(
      http.post(ACCEPT, async () => {
        calls += 1;
        await gate;
        return HttpResponse.json(JOIN);
      }),
    );
    renderWithClient(<MyOffersPage />);
    fireEvent.click(await screen.findByRole('button', { name: 'Принять' }));
    const pending = await screen.findByRole('button', { name: 'Принимаем…' });
    expect((pending as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole('button', { name: 'Отклонить' }) as HTMLButtonElement).disabled).toBe(
      true,
    );
    fireEvent.click(pending);
    release();
    expect(await screen.findByText('Вы вступили в команду.')).toBeTruthy();
    expect(calls).toBe(1);
  });

  it('a lost race shows the SEAT_TAKEN message in an alert', async () => {
    serve([sampleOffer()]);
    server.use(http.post(ACCEPT, () => problem(409, 'SEAT_TAKEN')));
    renderWithClient(<MyOffersPage />);
    fireEvent.click(await screen.findByRole('button', { name: 'Принять' }));
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain('Это место уже занято');
  });

  it.each([
    ['TEAM_FULL', 'В команде нет свободных мест.'],
    ['OFFER_LIMIT', 'Слишком много ожидающих предложений'],
    ['PROJECT_LIMIT', 'Достигнут лимит проектов'],
  ])('maps %s to a Russian message', async (code, text) => {
    serve([sampleOffer()]);
    server.use(http.post(ACCEPT, () => problem(409, code)));
    renderWithClient(<MyOffersPage />);
    fireEvent.click(await screen.findByRole('button', { name: 'Принять' }));
    expect((await screen.findByRole('alert')).textContent).toContain(text);
  });

  it('GITHUB_REQUIRED offers the GitHub linking link', async () => {
    serve([sampleOffer()]);
    server.use(http.post(ACCEPT, () => problem(409, 'GITHUB_REQUIRED')));
    renderWithClient(<MyOffersPage />);
    fireEvent.click(await screen.findByRole('button', { name: 'Принять' }));
    const link = await screen.findByRole('link', { name: 'Привязать GitHub' });
    expect(link.getAttribute('href')).toBe('/settings');
  });

  it('retry after a server failure reuses the same Idempotency-Key', async () => {
    serve([sampleOffer()]);
    const keys: (string | null)[] = [];
    server.use(
      http.post(ACCEPT, ({ request }) => {
        keys.push(request.headers.get('Idempotency-Key'));
        return keys.length === 1 ? problem(503, 'INTERNAL') : HttpResponse.json(JOIN);
      }),
    );
    renderWithClient(<MyOffersPage />);
    fireEvent.click(await screen.findByRole('button', { name: 'Принять' }));
    await screen.findByRole('alert');
    fireEvent.click(screen.getByRole('button', { name: 'Принять' }));
    await waitFor(() => expect(keys).toHaveLength(2));
    expect(keys[0]).toBeTruthy();
    expect(keys[1]).toBe(keys[0]);
  });

  it('own join requests can only be withdrawn', async () => {
    serve([sampleOffer({ direction: 'user_to_lead' })]);
    server.use(
      http.post(`${API}/v1/seat-offers/${OFFER_ID}/rejection`, () =>
        HttpResponse.json(sampleOffer({ direction: 'user_to_lead', status: 'cancelled' })),
      ),
    );
    renderWithClient(<MyOffersPage />);
    expect(await screen.findByText('Заявка в команду')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Принять' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Отозвать заявку' }));
    expect(await screen.findByText('Заявка отозвана.')).toBeTruthy();
  });
});
