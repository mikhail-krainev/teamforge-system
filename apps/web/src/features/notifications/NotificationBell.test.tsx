// @vitest-environment jsdom
import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { HttpResponse, http } from 'msw';
import { setupServer } from 'msw/node';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { TEAM_ID } from '@/features/teams/fixtures';
import { API, renderWithClient } from '@/test/support';
import type { Notification } from './api';
import { NotificationBell, notificationHref } from './NotificationBell';

vi.mock('@/lib/api/client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/api/client')>();
  return { ...actual, apiClient: actual.createApiClient({ baseUrl: 'http://localhost/api' }) };
});
vi.mock('next/link', () => ({
  default: ({ href, children, ...rest }: { href: string; children: React.ReactNode }) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
}));

const server = setupServer();
beforeAll(() => server.listen({ onUnhandledFrame: 'error' }));
afterEach(() => {
  cleanup();
  server.resetHandlers();
});
afterAll(() => server.close());

/** The contract types `payload` as an opaque object, so test data needs a cast. */
const payload = (value: Record<string, unknown>) => value as unknown as Notification['payload'];

let seq = 0;
function note(overrides: Partial<Notification> = {}): Notification {
  seq += 1;
  return {
    id: `0192f0a0-7c1e-7b3a-8d2f-0000000e${String(seq).padStart(4, '0')}`,
    type: 'member_joined',
    payload: payload({ teamId: TEAM_ID }),
    createdAt: '2026-01-01T10:00:00.000Z',
    readAt: null,
    ...overrides,
  };
}

/** A tiny stateful server: unread filter, cursor pages of two, read marks. */
function serve(initial: Notification[], signedIn = true) {
  const store = { items: initial, marked: [] as string[][] };
  server.use(
    http.get(`${API}/v1/me`, () =>
      signedIn ? HttpResponse.json({ id: 'u1' }) : new HttpResponse(null, { status: 401 }),
    ),
    http.get(`${API}/v1/me/notifications`, ({ request }) => {
      const params = new URL(request.url).searchParams;
      const rows = params.get('unread') ? store.items.filter((n) => !n.readAt) : store.items;
      if (params.get('unread')) return HttpResponse.json({ items: rows, nextCursor: null });
      const from = Number(params.get('cursor') ?? 0);
      const page = rows.slice(from, from + 2);
      const next = from + 2 < rows.length ? String(from + 2) : null;
      return HttpResponse.json({ items: page, nextCursor: next });
    }),
    http.post(`${API}/v1/me/notifications/read-marks`, async ({ request }) => {
      const { ids } = (await request.json()) as { ids: string[] };
      store.marked.push(ids);
      store.items = store.items.map((n) =>
        ids.includes(n.id) ? { ...n, readAt: '2026-01-02T10:00:00.000Z' } : n,
      );
      return new HttpResponse(null, { status: 204 });
    }),
  );
  return store;
}

const bell = () => screen.findByRole('button', { name: 'Уведомления' });

describe('notification bell', () => {
  it('shows the unread count as a named status', async () => {
    serve([note(), note(), note({ readAt: '2026-01-01T11:00:00.000Z' })]);
    renderWithClient(<NotificationBell />);
    const badge = await screen.findByRole('status', { name: 'Непрочитанных: 2' });
    expect(badge.textContent).toBe('2');
  });

  it('shows nothing for a guest and no badge when everything is read', async () => {
    serve([], false);
    const { container } = renderWithClient(<NotificationBell />);
    await waitFor(() => expect(container.querySelector('button')).toBeNull());
    cleanup();
    serve([note({ readAt: '2026-01-01T11:00:00.000Z' })]);
    renderWithClient(<NotificationBell />);
    await bell();
    expect(screen.queryByRole('status')).toBeNull();
  });

  it('opens a menu of items, in Russian, with a link to the team', async () => {
    serve([note({ type: 'leader_vote_opened' }), note({ type: 'unheard_of' })]);
    renderWithClient(<NotificationBell />);
    const button = await bell();
    expect(button.getAttribute('aria-expanded')).toBe('false');
    fireEvent.click(button);
    expect(button.getAttribute('aria-expanded')).toBe('true');
    const menu = await screen.findByRole('menu', { name: 'Список уведомлений' });
    const items = within(menu).getAllByRole('menuitem');
    expect(items).toHaveLength(2);
    expect(items[0]!.textContent).toContain('Открыто голосование за тимлида');
    expect(items[0]!.getAttribute('href')).toBe(`/teams/${TEAM_ID}/vote`);
    expect(items[1]!.textContent).toContain('Новое уведомление');
  });

  it('pages through the list by cursor', async () => {
    serve([note(), note(), note()]);
    renderWithClient(<NotificationBell />);
    fireEvent.click(await bell());
    const menu = await screen.findByRole('menu');
    expect(within(menu).getAllByRole('menuitem')).toHaveLength(2);
    fireEvent.click(screen.getByRole('button', { name: 'Показать ещё' }));
    await waitFor(() => expect(within(menu).getAllByRole('menuitem')).toHaveLength(3));
    expect(screen.queryByRole('button', { name: 'Показать ещё' })).toBeNull();
  });

  it('opening an unread item marks it read and updates the count', async () => {
    const store = serve([note(), note()]);
    renderWithClient(<NotificationBell />);
    await screen.findByRole('status', { name: 'Непрочитанных: 2' });
    fireEvent.click(await bell());
    const first = (await screen.findAllByRole('menuitem'))[0]!;
    fireEvent.click(first);
    await screen.findByRole('status', { name: 'Непрочитанных: 1' });
    expect(store.marked).toEqual([[store.items[0]!.id]]);
  });

  it('"mark all" sends the ids of the loaded unread items', async () => {
    const store = serve([note(), note(), note({ readAt: '2026-01-01T11:00:00.000Z' })]);
    renderWithClient(<NotificationBell />);
    fireEvent.click(await bell());
    fireEvent.click(await screen.findByRole('button', { name: 'Отметить все прочитанными' }));
    await waitFor(() => expect(store.marked).toHaveLength(1));
    expect(store.marked[0]).toHaveLength(2);
    await waitFor(() => expect(screen.queryByRole('status', { name: /Непрочитанных/ })).toBeNull());
  });

  it('Escape closes the menu and returns focus to the bell', async () => {
    serve([note()]);
    renderWithClient(<NotificationBell />);
    const button = await bell();
    fireEvent.click(button);
    await screen.findByRole('menu');
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(screen.queryByRole('menu')).toBeNull();
    expect(document.activeElement).toBe(button);
  });

  it('an empty list says so', async () => {
    serve([]);
    renderWithClient(<NotificationBell />);
    fireEvent.click(await bell());
    expect(await screen.findByText('Уведомлений пока нет.')).toBeTruthy();
  });
});

describe('notificationHref', () => {
  it('builds links only from a valid team id', () => {
    expect(notificationHref({ type: 'member_joined', payload: payload({ teamId: TEAM_ID }) })).toBe(
      `/teams/${TEAM_ID}`,
    );
    expect(notificationHref({ type: 'x', payload: payload({ teamId: '../../evil' }) })).toBeNull();
    expect(notificationHref({ type: 'x', payload: payload({}) })).toBeNull();
  });
});
