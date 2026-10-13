// @vitest-environment jsdom
import { cleanup, fireEvent, screen, waitFor } from '@testing-library/react';
import { HttpResponse, http } from 'msw';
import { setupServer } from 'msw/node';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  LEAD_ID,
  MEMBER_ID,
  ROLE_LIST,
  SEAT_ID,
  TEAM_ID,
  sampleTeam,
} from '@/features/teams/fixtures';
import { problem } from '@/mocks/slice2/handlers';
import { API, renderWithClient } from '@/test/support';
import { OFFER_ID, OTHER_USER_ID, sampleOffer } from './fixtures';
import { TeamOffersPage } from './TeamOffersPage';

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

function serve(meId: string, items: unknown[] = []) {
  server.use(
    http.get(`${API}/v1/me`, () => HttpResponse.json({ id: meId })),
    http.get(`${API}/v1/catalog/roles`, () =>
      HttpResponse.json({ items: ROLE_LIST, nextCursor: null }),
    ),
    http.get(`${API}/v1/product-types`, () => HttpResponse.json({ items: [] })),
    http.get(`${API}/v1/teams/${TEAM_ID}`, () => HttpResponse.json(sampleTeam())),
    http.get(`${API}/v1/teams/${TEAM_ID}/seat-offers`, () =>
      HttpResponse.json({ items, nextCursor: null }),
    ),
  );
}
const open = () => renderWithClient(<TeamOffersPage teamId={TEAM_ID} />);

describe('FR-TEAM-28: TeamOffersPage', () => {
  it('the lead sends an offer for an open seat with the typed body', async () => {
    serve(LEAD_ID);
    let body: unknown;
    let key: string | null = null;
    server.use(
      http.post(`${API}/v1/teams/${TEAM_ID}/seat-offers`, async ({ request }) => {
        body = await request.json();
        key = request.headers.get('Idempotency-Key');
        return HttpResponse.json(sampleOffer(), { status: 201 });
      }),
    );
    open();
    fireEvent.click(await screen.findByRole('button', { name: 'Предложить место' }));
    await screen.findByRole('option', { name: /Backend-разработчик/ });
    fireEvent.change(screen.getByLabelText('Место'), { target: { value: SEAT_ID } });
    fireEvent.change(screen.getByLabelText('Идентификатор пользователя'), {
      target: { value: OTHER_USER_ID },
    });
    fireEvent.change(screen.getByLabelText(/Сообщение/), { target: { value: 'Привет' } });
    fireEvent.click(screen.getByRole('button', { name: 'Отправить предложение' }));
    expect(await screen.findByText('Предложение отправлено.')).toBeTruthy();
    expect(body).toEqual({ seatId: SEAT_ID, userId: OTHER_USER_ID, message: 'Привет' });
    expect(key).toBeTruthy();
  });

  it('validates the form without sending a request', async () => {
    serve(LEAD_ID);
    open();
    fireEvent.click(await screen.findByRole('button', { name: 'Предложить место' }));
    fireEvent.click(screen.getByRole('button', { name: 'Отправить предложение' }));
    expect(await screen.findByText('Выберите место.')).toBeTruthy();
    expect(screen.getByText(/Укажите идентификатор пользователя/)).toBeTruthy();
    await waitFor(() => expect(document.activeElement?.id).toBe('offer-seat'));
  });

  it('OFFER_LIMIT on send is announced', async () => {
    serve(LEAD_ID);
    server.use(
      http.post(`${API}/v1/teams/${TEAM_ID}/seat-offers`, () => problem(409, 'OFFER_LIMIT')),
    );
    open();
    fireEvent.click(await screen.findByRole('button', { name: 'Предложить место' }));
    await screen.findByRole('option', { name: /Backend-разработчик/ });
    fireEvent.change(screen.getByLabelText('Место'), { target: { value: SEAT_ID } });
    fireEvent.change(screen.getByLabelText('Идентификатор пользователя'), {
      target: { value: OTHER_USER_ID },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Отправить предложение' }));
    expect((await screen.findByRole('alert')).textContent).toContain('Слишком много ожидающих');
  });

  it('the lead accepts a join request', async () => {
    serve(LEAD_ID, [sampleOffer({ direction: 'user_to_lead' })]);
    server.use(
      http.post(`${API}/v1/seat-offers/${OFFER_ID}/acceptance`, () =>
        HttpResponse.json({
          teamId: TEAM_ID,
          seatId: SEAT_ID,
          roleCode: 'backend',
          joinedVia: 'request',
          trialUntil: null,
          deficitAtJoin: false,
        }),
      ),
    );
    open();
    fireEvent.click(await screen.findByRole('button', { name: 'Принять заявку' }));
    expect(await screen.findByText('Заявка принята: участник в команде.')).toBeTruthy();
  });

  it('a pending offer can be withdrawn but not accepted by the lead', async () => {
    serve(LEAD_ID, [sampleOffer()]);
    open();
    expect(await screen.findByRole('button', { name: 'Отозвать предложение' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Принять заявку' })).toBeNull();
  });

  it('a non-lead gets no composer', async () => {
    serve(MEMBER_ID);
    server.use(
      http.get(`${API}/v1/teams/${TEAM_ID}/seat-offers`, () => problem(403, 'NOT_TEAM_LEAD')),
    );
    open();
    expect((await screen.findByRole('alert')).textContent).toContain('только тимлид');
    expect(screen.queryByRole('button', { name: 'Предложить место' })).toBeNull();
  });
});
