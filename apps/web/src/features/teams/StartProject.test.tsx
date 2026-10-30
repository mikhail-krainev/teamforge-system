// @vitest-environment jsdom
import { cleanup, fireEvent, screen, waitFor } from '@testing-library/react';
import { HttpResponse, http } from 'msw';
import { setupServer } from 'msw/node';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { problem } from '@/mocks/slice2/handlers';
import { API, renderWithClient } from '@/test/support';
import { LEAD_ID, MEMBER_ID, PRODUCT_TYPES, ROLE_LIST, TEAM_ID, sampleTeam } from './fixtures';
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

const START = `${API}/v1/teams/${TEAM_ID}/start`;

function serve(meId: string, status: 'forming' | 'active' | 'voting' = 'forming') {
  const state = { status };
  server.use(
    http.get(`${API}/v1/me`, () => HttpResponse.json({ id: meId })),
    http.get(`${API}/v1/catalog/roles`, () =>
      HttpResponse.json({ items: ROLE_LIST, nextCursor: null }),
    ),
    http.get(`${API}/v1/product-types`, () => HttpResponse.json({ items: PRODUCT_TYPES })),
    http.get(`${API}/v1/teams/${TEAM_ID}`, () =>
      HttpResponse.json(sampleTeam({ status: state.status })),
    ),
    http.get(`${API}/v1/teams/${TEAM_ID}/events`, () =>
      HttpResponse.json({ items: [], nextCursor: null }),
    ),
  );
  return state;
}

const open = () => renderWithClient(<TeamDetailPage teamId={TEAM_ID} />);
const startButton = () => screen.findByRole('button', { name: 'Начать проект' });

describe('FR-TEAM-27: start the project', () => {
  it('asks for confirmation, then starts and shows the new status', async () => {
    const state = serve(LEAD_ID);
    let calls = 0;
    let key: string | null = null;
    server.use(
      http.post(START, ({ request }) => {
        calls += 1;
        key = request.headers.get('Idempotency-Key');
        state.status = 'active';
        return HttpResponse.json(sampleTeam({ status: 'active' }));
      }),
    );
    open();
    expect((await screen.findByRole('status', { name: 'Статус команды' })).textContent).toBe(
      'Статус: Формируется',
    );
    fireEvent.click(await startButton());
    expect(calls).toBe(0);
    fireEvent.click(screen.getByRole('button', { name: 'Да, начать' }));
    await waitFor(() =>
      expect(screen.getByRole('status', { name: 'Статус команды' }).textContent).toBe(
        'Статус: Активна',
      ),
    );
    expect(calls).toBe(1);
    expect(key).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Начать проект' })).toBeNull();
  });

  it('cancel keeps the team forming', async () => {
    serve(LEAD_ID);
    open();
    fireEvent.click(await startButton());
    fireEvent.click(screen.getByRole('button', { name: 'Отмена' }));
    expect(screen.getByRole('button', { name: 'Начать проект' })).toBeTruthy();
  });

  it('INVALID_STATE (a repeated start) is explained', async () => {
    serve(LEAD_ID);
    server.use(http.post(START, () => problem(409, 'INVALID_STATE')));
    open();
    fireEvent.click(await startButton());
    fireEvent.click(screen.getByRole('button', { name: 'Да, начать' }));
    expect((await screen.findByRole('alert')).textContent).toContain('Проект уже начался');
  });

  it('TEAM_STATUS_BLOCKS_ACTION (voting or suspended) is explained', async () => {
    serve(LEAD_ID);
    server.use(http.post(START, () => problem(409, 'TEAM_STATUS_BLOCKS_ACTION')));
    open();
    fireEvent.click(await startButton());
    fireEvent.click(screen.getByRole('button', { name: 'Да, начать' }));
    expect((await screen.findByRole('alert')).textContent).toContain('идёт голосование');
  });

  it('is not offered to a non-lead or once the project is active', async () => {
    serve(MEMBER_ID);
    open();
    await screen.findByRole('heading', { level: 1 });
    expect(screen.queryByRole('button', { name: 'Начать проект' })).toBeNull();
    cleanup();
    serve(LEAD_ID, 'active');
    open();
    await screen.findByRole('heading', { level: 1 });
    expect(screen.queryByRole('button', { name: 'Начать проект' })).toBeNull();
  });

  it('a team in voting links members to the vote page', async () => {
    serve(MEMBER_ID, 'voting');
    server.use(
      http.get(`${API}/v1/teams/${TEAM_ID}`, () =>
        HttpResponse.json(
          sampleTeam({
            status: 'voting',
            members: [
              { ...sampleTeam().members[0]!, userId: MEMBER_ID, displayName: 'Борис Иванов' },
            ],
          }),
        ),
      ),
    );
    open();
    const link = await screen.findByRole('link', { name: 'Голосование за тимлида' });
    expect(link.getAttribute('href')).toBe(`/teams/${TEAM_ID}/vote`);
  });
});
