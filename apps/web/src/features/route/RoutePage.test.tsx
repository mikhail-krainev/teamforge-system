// @vitest-environment jsdom
import { cleanup, screen, within } from '@testing-library/react';
import { HttpResponse, http } from 'msw';
import { setupServer } from 'msw/node';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { problem } from '@/mocks/slice2/handlers';
import { API, renderWithClient } from '@/test/support';
import { activeTeam, sampleStage, TEAM_ID } from './fixtures';
import { RoutePage } from './RoutePage';

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

const TEAM_URL = `${API}/v1/teams/${TEAM_ID}`;

function serve(items: ReturnType<typeof sampleStage>[], plannedEndAt: string | null) {
  server.use(
    http.get(TEAM_URL, () => HttpResponse.json(activeTeam())),
    http.get(`${TEAM_URL}/stages`, () => HttpResponse.json({ items, plannedEndAt })),
  );
}

describe('FR-WORK-01, FR-WORK-12: route of a project', () => {
  it('lists the stages in order, marks the current one and shows the due dates', async () => {
    serve(
      [
        sampleStage({
          ordinal: 2,
          title: 'Этап 2. Работа',
          status: 'pending',
          openedAt: null,
          dueAt: null,
        }),
        sampleStage(),
      ],
      '2099-01-01T00:00:00Z',
    );
    renderWithClient(<RoutePage teamId={TEAM_ID} />);
    expect(await screen.findByRole('heading', { level: 1, name: 'Маршрут проекта' })).toBeTruthy();
    const items = within(screen.getByRole('list', { name: 'Этапы проекта' })).getAllByRole(
      'listitem',
    );
    expect(items).toHaveLength(2);
    expect(items[0]?.textContent).toContain('Этап 1. Старт');
    expect(items[0]?.getAttribute('aria-current')).toBe('step');
    expect(items[0]?.textContent).toContain('Срок до');
    expect(items[1]?.getAttribute('aria-current')).toBeNull();
    expect(items[1]?.textContent).toContain('Ожидает');
    expect(screen.getByText(/Плановая дата окончания проекта/)).toBeTruthy();
    expect(screen.queryByText(/уже прошла/)).toBeNull();
  });

  it('warns, without blocking, when the planned end date has passed', async () => {
    serve([sampleStage({ overdue: true })], '2020-01-01T00:00:00Z');
    renderWithClient(<RoutePage teamId={TEAM_ID} />);
    expect(await screen.findByText(/уже прошла/)).toBeTruthy();
    expect(screen.getByText(/Срок этапа прошёл/)).toBeTruthy();
  });

  it('says the project has not started when there are no stages', async () => {
    serve([], null);
    renderWithClient(<RoutePage teamId={TEAM_ID} />);
    expect(await screen.findByText(/Проект ещё не начался/)).toBeTruthy();
  });

  it('reports a missing team without a retry button', async () => {
    server.use(
      http.get(TEAM_URL, () => problem(404, 'NOT_FOUND')),
      http.get(`${TEAM_URL}/stages`, () => problem(404, 'NOT_FOUND')),
    );
    renderWithClient(<RoutePage teamId={TEAM_ID} />);
    expect((await screen.findByRole('alert')).textContent).toContain('Команда не найдена');
    expect(screen.queryByRole('button', { name: 'Повторить' })).toBeNull();
  });
});
