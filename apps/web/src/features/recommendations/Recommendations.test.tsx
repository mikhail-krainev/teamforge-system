// @vitest-environment jsdom
import { cleanup, fireEvent, screen, within } from '@testing-library/react';
import { HttpResponse, http } from 'msw';
import { setupServer } from 'msw/node';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { sampleReasons } from '@/features/matching/fixtures';
import { LEAD_ID, MEMBER_ID, ROLE_LIST, SEAT_ID, TEAM_ID, sampleSeat, sampleTeam } from '@/features/teams/fixtures';
import { problem } from '@/mocks/slice2/handlers';
import { API, renderWithClient } from '@/test/support';
import { reasonLines } from './MatchExplanation';
import { RecommendedTeams } from './RecommendedTeams';
import { SeatCandidatesPage } from './SeatCandidatesPage';

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

const RECOMMENDATION = {
  teamId: TEAM_ID,
  teamName: 'Команда Альфа',
  seatId: SEAT_ID,
  roleCode: 'backend',
  score: 0.82,
  reasons: sampleReasons(),
  computedAt: '2026-01-01T10:00:00.000Z',
};

describe('MatchExplanation', () => {
  it('turns every factor of the contract into a line', () => {
    expect(reasonLines(sampleReasons())).toEqual([
      'Роль совпадает',
      'Стек: 80% (общие технологии: node, react)',
      'Уровень: 100%',
      'Часовой пояс: 70% (разница 2 ч)',
      'Доступность: 90%',
      'Опыт завершённых проектов: 50%',
    ]);
  });

  it('omits the tags and the time difference when the server has none', () => {
    const lines = reasonLines(
      sampleReasons({ role: false, matchedStackTags: [], timezoneDiffHours: undefined }),
    );
    expect(lines.slice(0, 2)).toEqual(['Роль не совпадает', 'Стек: 80%']);
    expect(lines[3]).toBe('Часовой пояс: 70%');
  });
});

describe('FR-MATCH-02: RecommendedTeams', () => {
  it('shows the explanation and sends a join request for the recommended seat', async () => {
    let body: unknown;
    let key: string | null = null;
    server.use(
      http.get(`${API}/v1/me/recommended-teams`, () =>
        HttpResponse.json({ items: [RECOMMENDATION], nextCursor: null }),
      ),
      http.post(`${API}/v1/teams/${TEAM_ID}/join-requests`, async ({ request }) => {
        body = await request.json();
        key = request.headers.get('Idempotency-Key');
        return HttpResponse.json({}, { status: 201 });
      }),
    );
    renderWithClient(<RecommendedTeams roles={ROLE_LIST} />);
    const list = await screen.findByRole('list', { name: 'Рекомендованные команды' });
    expect(within(list).getByRole('link', { name: 'Команда Альфа' }).getAttribute('href')).toBe(
      `/teams/${TEAM_ID}`,
    );
    expect(within(list).getByText('Роль: Backend-разработчик')).toBeTruthy();
    expect(within(list).getByText('Совпадение 82%')).toBeTruthy();
    expect(within(list).getByText('Роль совпадает')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: /Подать заявку/ }));
    expect(await screen.findByText(/Заявка отправлена\./)).toBeTruthy();
    expect(body).toEqual({ seatId: SEAT_ID });
    expect(key).toBeTruthy();
  });

  it('announces a refused join request', async () => {
    server.use(
      http.get(`${API}/v1/me/recommended-teams`, () =>
        HttpResponse.json({ items: [RECOMMENDATION], nextCursor: null }),
      ),
      http.post(`${API}/v1/teams/${TEAM_ID}/join-requests`, () => problem(409, 'SEAT_TAKEN')),
    );
    renderWithClient(<RecommendedTeams roles={ROLE_LIST} />);
    fireEvent.click(await screen.findByRole('button', { name: /Подать заявку/ }));
    expect((await screen.findByRole('alert')).textContent).toContain('Это место уже занято');
  });

  it('shows the empty state and the error state', async () => {
    server.use(
      http.get(`${API}/v1/me/recommended-teams`, () =>
        HttpResponse.json({ items: [], nextCursor: null }),
      ),
    );
    const first = renderWithClient(<RecommendedTeams roles={ROLE_LIST} />);
    expect(await screen.findByText(/Рекомендаций пока нет/)).toBeTruthy();
    first.unmount();
    server.use(http.get(`${API}/v1/me/recommended-teams`, () => problem(403, 'FORBIDDEN')));
    renderWithClient(<RecommendedTeams roles={ROLE_LIST} />);
    expect(await screen.findByText('Не получилось загрузить рекомендации.')).toBeTruthy();
  });

  it('loads the next page by cursor', async () => {
    server.use(
      http.get(`${API}/v1/me/recommended-teams`, ({ request }) =>
        new URL(request.url).searchParams.get('cursor')
          ? HttpResponse.json({
              items: [{ ...RECOMMENDATION, teamName: 'Команда Бета', seatId: MEMBER_ID }],
              nextCursor: null,
            })
          : HttpResponse.json({ items: [RECOMMENDATION], nextCursor: 'c2' }),
      ),
    );
    renderWithClient(<RecommendedTeams roles={ROLE_LIST} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Показать ещё' }));
    expect(await screen.findByRole('link', { name: 'Команда Бета' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Показать ещё' })).toBeNull();
  });
});

const CANDIDATE_ID = '0192f0a0-7c1e-7b3a-8d2f-0000000000cc';
const CANDIDATE = {
  userId: CANDIDATE_ID,
  displayName: 'Иван Петров',
  score: 0.9,
  reasons: sampleReasons(),
  inQueue: true,
  computedAt: '2026-01-01T10:00:00.000Z',
};

function serveSeat(meId: string, seats = [sampleSeat()]) {
  server.use(
    http.get(`${API}/v1/me`, () => HttpResponse.json({ id: meId })),
    http.get(`${API}/v1/catalog/roles`, () =>
      HttpResponse.json({ items: ROLE_LIST, nextCursor: null }),
    ),
    http.get(`${API}/v1/teams/${TEAM_ID}`, () => HttpResponse.json(sampleTeam({ seats }))),
    http.get(`${API}/v1/teams/${TEAM_ID}/seats/${SEAT_ID}/candidates`, () =>
      HttpResponse.json({ items: [CANDIDATE], nextCursor: null }),
    ),
  );
}
const openPage = () => renderWithClient(<SeatCandidatesPage teamId={TEAM_ID} seatId={SEAT_ID} />);

describe('FR-MATCH-01: SeatCandidatesPage', () => {
  it('lists candidates for the lead and offers the seat with the typed body', async () => {
    serveSeat(LEAD_ID);
    let body: unknown;
    server.use(
      http.post(`${API}/v1/teams/${TEAM_ID}/seat-offers`, async ({ request }) => {
        body = await request.json();
        return HttpResponse.json({}, { status: 201 });
      }),
    );
    openPage();
    const list = await screen.findByRole('list', { name: 'Рекомендованные кандидаты' });
    expect(within(list).getByRole('link', { name: 'Иван Петров' })).toBeTruthy();
    expect(within(list).getByText('в очереди')).toBeTruthy();
    expect(screen.getByText('Место 1 · Backend-разработчик')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Предложить: Иван Петров' }));
    expect(await screen.findByText('Предложение отправлено.')).toBeTruthy();
    expect(body).toEqual({ seatId: SEAT_ID, userId: CANDIDATE_ID });
  });

  it('announces OFFER_LIMIT of an offer', async () => {
    serveSeat(LEAD_ID);
    server.use(
      http.post(`${API}/v1/teams/${TEAM_ID}/seat-offers`, () => problem(409, 'OFFER_LIMIT')),
    );
    openPage();
    fireEvent.click(await screen.findByRole('button', { name: /Предложить/ }));
    expect((await screen.findByRole('alert')).textContent).toContain('Слишком много ожидающих');
  });

  it('does not load candidates for someone who is not the lead', async () => {
    serveSeat(MEMBER_ID);
    openPage();
    expect(await screen.findByText('Кандидатов видит только тимлид команды.')).toBeTruthy();
    expect(screen.queryByRole('list', { name: 'Рекомендованные кандидаты' })).toBeNull();
  });

  it('says so when the seat is not open any more or is not in the team', async () => {
    serveSeat(LEAD_ID, [sampleSeat({ status: 'filled', holderUserId: MEMBER_ID })]);
    const first = openPage();
    expect(await screen.findByText(/Это место уже закрыто/)).toBeTruthy();
    first.unmount();
    serveSeat(LEAD_ID, []);
    openPage();
    expect(await screen.findByText('Такого места в команде нет.')).toBeTruthy();
  });

  it('shows the empty state of the list', async () => {
    serveSeat(LEAD_ID);
    server.use(
      http.get(`${API}/v1/teams/${TEAM_ID}/seats/${SEAT_ID}/candidates`, () =>
        HttpResponse.json({ items: [], nextCursor: null }),
      ),
    );
    openPage();
    expect(await screen.findByText('Подходящих кандидатов пока нет.')).toBeTruthy();
  });
});
