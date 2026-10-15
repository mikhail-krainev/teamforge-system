// @vitest-environment jsdom
import { cleanup, screen, within } from '@testing-library/react';
import { HttpResponse, http } from 'msw';
import { setupServer } from 'msw/node';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { ROLE_LIST } from '@/features/teams/fixtures';
import { problem } from '@/mocks/slice2/handlers';
import { API, renderWithClient } from '@/test/support';
import { DemandPage } from './DemandPage';
import { sampleDemand } from './fixtures';
import { RoleDemandBlock } from './RoleDemandBlock';

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

function serveRoles() {
  server.use(
    http.get(`${API}/v1/catalog/roles`, () =>
      HttpResponse.json({ items: ROLE_LIST, nextCursor: null }),
    ),
  );
}

describe('FR-MATCH-09: DemandPage', () => {
  it('lists open seats, queue size and wait for every role', async () => {
    serveRoles();
    let roles: string[] = [];
    server.use(
      http.get(`${API}/v1/demand`, ({ request }) => {
        roles = new URL(request.url).searchParams.getAll('roles');
        return HttpResponse.json({
          items: [
            sampleDemand(),
            sampleDemand({
              roleCode: 'qa',
              openSeats: 0,
              queuedCandidates: 1,
              avgWaitSeconds: null,
              avgWaitStatus: 'insufficient_data',
              deficit: false,
            }),
          ],
        });
      }),
    );
    renderWithClient(<DemandPage />);
    const table = await screen.findByRole('table', { name: 'Спрос и очередь по ролям' });
    const rows = within(table).getAllByRole('row');
    expect(within(rows[1] as HTMLElement).getAllByRole('cell').map((c) => c.textContent)).toEqual([
      '4',
      '3',
      '7',
      'около 3 дн.',
      'дефицит',
    ]);
    expect(within(rows[2] as HTMLElement).getAllByRole('cell').map((c) => c.textContent)).toEqual([
      '0',
      '3',
      '1',
      'мало данных',
      'нет',
    ]);
    expect(roles).toEqual(ROLE_LIST.map((r) => r.code));
  });

  it('shows the empty state', async () => {
    serveRoles();
    server.use(http.get(`${API}/v1/demand`, () => HttpResponse.json({ items: [] })));
    renderWithClient(<DemandPage />);
    expect(await screen.findByText('Данных о спросе пока нет.')).toBeTruthy();
  });

  it('shows a loading state, then an error with a retry button', async () => {
    serveRoles();
    server.use(http.get(`${API}/v1/demand`, () => problem(403, 'FORBIDDEN')));
    renderWithClient(<DemandPage />);
    expect(screen.getByRole('status').textContent).toBe('Загружаем спрос…');
    expect(await screen.findByText('Не удалось загрузить спрос на роли.')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Повторить' })).toBeTruthy();
  });
});

describe('FR-PROF-07: RoleDemandBlock', () => {
  it('shows one line per desired role and links to the full demand page', async () => {
    serveRoles();
    server.use(http.get(`${API}/v1/demand`, () => HttpResponse.json({ items: [sampleDemand()] })));
    renderWithClient(<RoleDemandBlock />);
    expect(
      await screen.findByText(
        'Backend-разработчик: открытых мест 4, в очереди 7, ожидание: около 3 дн.',
      ),
    ).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Подробнее о спросе' }).getAttribute('href')).toBe(
      '/demand',
    );
  });

  it('asks the server for the desired roles of the profile (no roles filter)', async () => {
    serveRoles();
    let query = 'unset';
    server.use(
      http.get(`${API}/v1/demand`, ({ request }) => {
        query = new URL(request.url).search;
        return HttpResponse.json({ items: [] });
      }),
    );
    renderWithClient(<RoleDemandBlock />);
    expect(await screen.findByText(/Укажите желаемые роли в профиле/)).toBeTruthy();
    expect(query).toBe('');
  });

  it('shows an error without breaking the page', async () => {
    serveRoles();
    server.use(http.get(`${API}/v1/demand`, () => problem(403, 'FORBIDDEN')));
    renderWithClient(<RoleDemandBlock />);
    expect(await screen.findByText('Не удалось загрузить спрос.')).toBeTruthy();
  });
});
