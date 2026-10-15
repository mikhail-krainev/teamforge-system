// @vitest-environment jsdom
import { cleanup, fireEvent, screen, waitFor } from '@testing-library/react';
import { HttpResponse, http } from 'msw';
import { setupServer } from 'msw/node';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { problem } from '@/mocks/slice2/handlers';
import { API, renderWithClient } from '@/test/support';
import type { Team } from './api';
import {
  LEAD_ID,
  MEMBER_ID,
  PRODUCT_TYPES,
  ROLE_LIST,
  SEAT_ID,
  TEAM_ID,
  sampleSeat,
  sampleTeam,
} from './fixtures';
import { TeamDetailPage } from './TeamDetailPage';

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

const SEAT_URL = `${API}/v1/teams/${TEAM_ID}/seats/${SEAT_ID}`;
const EVENT = {
  id: '0192f0a0-7c1e-7b3a-8d2f-00000000e001',
  type: 'team.created',
  actorUserId: LEAD_ID,
  payload: {},
  at: '2026-01-01T10:00:00.000Z',
};

function serve(team: Team, meId: string) {
  server.use(
    http.get(`${API}/v1/me`, () => HttpResponse.json({ id: meId })),
    http.get(`${API}/v1/catalog/roles`, () =>
      HttpResponse.json({ items: ROLE_LIST, nextCursor: null }),
    ),
    http.get(`${API}/v1/product-types`, () => HttpResponse.json({ items: PRODUCT_TYPES })),
    http.get(`${API}/v1/teams/${TEAM_ID}`, () => HttpResponse.json(team)),
    http.get(`${API}/v1/teams/${TEAM_ID}/events`, ({ request }) =>
      new URL(request.url).searchParams.get('cursor')
        ? HttpResponse.json({ items: [], nextCursor: null })
        : HttpResponse.json({ items: [EVENT], nextCursor: 'e2' }),
    ),
  );
}
const open = () => renderWithClient(<TeamDetailPage teamId={TEAM_ID} />);
const seatHeading = () => screen.findByRole('heading', { name: 'Backend-разработчик' });

describe('FR-TEAM-02: TeamDetailPage', () => {
  it('shows roster, seats, status and events', async () => {
    serve(sampleTeam({ name: '<b>Альфа</b>' }), MEMBER_ID);
    const { container } = open();
    expect(await screen.findByRole('heading', { level: 1, name: '<b>Альфа</b>' })).toBeTruthy();
    expect(container.querySelector('b')).toBeNull();
    expect(screen.getByText('Статус: Формируется')).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Анна Смирнова' })).toBeTruthy();
    expect(await seatHeading()).toBeTruthy();
    expect(await screen.findByText('Команда создана')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Показать ещё' })).toBeTruthy();
  });

  it('a non-lead cannot manage seats', async () => {
    serve(sampleTeam(), MEMBER_ID);
    open();
    await seatHeading();
    expect(screen.queryByRole('button', { name: 'Закрыть место' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Добавить место' })).toBeNull();
  });

  it('the lead marks a seat as desired, sending its version', async () => {
    serve(sampleTeam(), LEAD_ID);
    let body: unknown;
    let key: string | null = null;
    server.use(
      http.patch(SEAT_URL, async ({ request }) => {
        body = await request.json();
        key = request.headers.get('Idempotency-Key');
        return HttpResponse.json(sampleSeat({ desired: true, version: 4 }));
      }),
    );
    open();
    fireEvent.click(await screen.findByRole('button', { name: 'Отметить желательным' }));
    await waitFor(() => expect(body).toEqual({ version: 3, desired: true }));
    expect(key).toBeTruthy();
  });

  it('VERSION_CONFLICT on a seat edit asks to refresh', async () => {
    serve(sampleTeam(), LEAD_ID);
    server.use(http.patch(SEAT_URL, () => problem(409, 'VERSION_CONFLICT')));
    open();
    fireEvent.click(await screen.findByRole('button', { name: 'Изменить' }));
    fireEvent.change(screen.getByLabelText(/Минимум часов/), { target: { value: '20' } });
    fireEvent.click(screen.getByRole('button', { name: 'Сохранить' }));
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain('изменил кто-то другой');
    expect(screen.getByRole('button', { name: 'Обновить данные' })).toBeTruthy();
  });

  it('the edit form focuses the invalid hours field', async () => {
    serve(sampleTeam(), LEAD_ID);
    open();
    fireEvent.click(await screen.findByRole('button', { name: 'Изменить' }));
    const hours = screen.getByLabelText(/Минимум часов/);
    fireEvent.change(hours, { target: { value: '1' } });
    fireEvent.click(screen.getByRole('button', { name: 'Сохранить' }));
    await waitFor(() => expect(document.activeElement).toBe(hours));
    expect(hours.getAttribute('aria-invalid')).toBe('true');
  });

  it('the lead closes an open seat', async () => {
    serve(sampleTeam(), LEAD_ID);
    let called = false;
    server.use(
      http.delete(SEAT_URL, () => {
        called = true;
        return new HttpResponse(null, { status: 204 });
      }),
    );
    open();
    fireEvent.click(await screen.findByRole('button', { name: 'Закрыть место' }));
    await waitFor(() => expect(called).toBe(true));
  });

  it('adding a seat validates first, then explains a 409', async () => {
    serve(sampleTeam(), LEAD_ID);
    server.use(http.post(`${API}/v1/teams/${TEAM_ID}/seats`, () => problem(409, 'TEAM_FULL')));
    open();
    fireEvent.click(await screen.findByRole('button', { name: 'Добавить место' }));
    fireEvent.click(screen.getByRole('button', { name: 'Добавить' }));
    await waitFor(() => expect(document.activeElement?.id).toBe('new-seat-roleCode'));
    fireEvent.change(screen.getByLabelText(/^Роль/), { target: { value: 'qa' } });
    fireEvent.click(screen.getByRole('button', { name: 'Добавить' }));
    expect((await screen.findByRole('alert')).textContent).toContain('нет свободных мест');
  });

  it('a missing team is reported', async () => {
    server.use(
      http.get(`${API}/v1/me`, () => HttpResponse.json({ id: LEAD_ID })),
      http.get(`${API}/v1/catalog/roles`, () => HttpResponse.json({ items: [], nextCursor: null })),
      http.get(`${API}/v1/product-types`, () => HttpResponse.json({ items: [] })),
      http.get(`${API}/v1/teams/${TEAM_ID}`, () => problem(404, 'NOT_FOUND')),
    );
    open();
    expect((await screen.findByRole('alert')).textContent).toContain('Команда не найдена');
  });
});
