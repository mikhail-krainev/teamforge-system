// @vitest-environment jsdom
import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { HttpResponse, http } from 'msw';
import { setupServer } from 'msw/node';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { activeTeam, LEAD_ID, MEMBER_ID, TEAM_ID } from '@/features/route/fixtures';
import { problem } from '@/mocks/slice2/handlers';
import { API, renderWithClient } from '@/test/support';
import { formatDay } from './model';
import { ReviewsPage } from './ReviewsPage';

vi.mock('@/lib/api/client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/api/client')>();
  return { ...actual, apiClient: actual.createApiClient({ baseUrl: 'http://localhost/api' }) };
});

const server = setupServer();
beforeAll(() => server.listen({ onUnhandledFrame: 'error' }));
afterEach(() => {
  cleanup();
  server.resetHandlers();
});
afterAll(() => server.close());

const TEAM_URL = `${API}/v1/teams/${TEAM_ID}`;
const finished = () => activeTeam({ status: 'completed' });

interface Setup {
  sent?: { subjectUserId: string; status: 'sent' }[];
  received?: unknown[];
}

function serve({ sent = [], received = [] }: Setup = {}) {
  const posts: unknown[] = [];
  let sentNow = sent;
  server.use(
    http.get(`${API}/v1/me`, () => HttpResponse.json({ id: LEAD_ID })),
    http.get(`${API}/v1/me/teams`, () =>
      HttpResponse.json({
        items: [
          {
            team: { ...finished(), openSeats: [] },
            myRoles: ['pm'],
            isLead: true,
            membershipStatus: 'active',
          },
        ],
        nextCursor: null,
      }),
    ),
    http.get(TEAM_URL, () => HttpResponse.json(finished())),
    http.get(`${TEAM_URL}/reviews/sent`, () =>
      HttpResponse.json({ items: sentNow, windowClosesAt: '2026-11-04T00:00:00.000Z' }),
    ),
    http.get(`${API}/v1/me/reviews`, () => HttpResponse.json({ items: received, nextCursor: null })),
    http.post(`${TEAM_URL}/reviews`, async ({ request }) => {
      const body = (await request.json()) as { subjectUserId: string };
      posts.push(body);
      sentNow = [...sentNow, { subjectUserId: body.subjectUserId, status: 'sent' }];
      return HttpResponse.json({ subjectUserId: body.subjectUserId, status: 'sent' }, { status: 201 });
    }),
  );
  return posts;
}

describe('FR-PROF-08: the form', () => {
  it('offers only the colleagues, never oneself, and announces the batch after a send', async () => {
    const posts = serve();
    renderWithClient(<ReviewsPage />);
    const form = await screen.findByRole('form', { name: 'Оставить отзыв' });
    const select = within(form).getByLabelText('Кому') as HTMLSelectElement;
    const names = Array.from(select.options).map((option) => option.textContent);
    expect(names).toEqual(['Выберите коллегу', 'Борис Иванов']);
    expect(screen.getByText(/Отзывы будут опубликованы пакетом/)).toBeTruthy();

    fireEvent.change(select, { target: { value: MEMBER_ID } });
    fireEvent.change(within(form).getByLabelText('Текст отзыва'), {
      target: { value: 'Спасибо за аккуратные pull request-ы.' },
    });
    fireEvent.click(within(form).getByRole('button', { name: 'Отправить отзыв' }));
    const notice = await screen.findByRole('status', { name: '' });
    expect(notice.textContent).toMatch(/Отзывы будут опубликованы пакетом/);
    expect(posts).toEqual([{ subjectUserId: MEMBER_ID, text: 'Спасибо за аккуратные pull request-ы.' }]);
    expect(await screen.findByText(/Вы уже оставили отзывы всем коллегам/)).toBeTruthy();
    const sent = screen.getByRole('region', { name: 'Отправленные отзывы' });
    expect(within(sent).getAllByRole('listitem')).toHaveLength(1);
  });

  it('asks for the colleague and the text before sending anything', async () => {
    const posts = serve();
    renderWithClient(<ReviewsPage />);
    const form = await screen.findByRole('form', { name: 'Оставить отзыв' });
    fireEvent.click(within(form).getByRole('button', { name: 'Отправить отзыв' }));
    expect(await within(form).findByText('Выберите коллегу.')).toBeTruthy();
    expect(posts).toHaveLength(0);
  });

  it('explains a closed window and shows the general error for an unknown code', async () => {
    serve();
    let code = 'REVIEW_WINDOW_CLOSED';
    server.use(http.post(`${TEAM_URL}/reviews`, () => problem(409, code)));
    renderWithClient(<ReviewsPage />);
    const form = await screen.findByRole('form', { name: 'Оставить отзыв' });
    fireEvent.change(within(form).getByLabelText('Кому'), { target: { value: MEMBER_ID } });
    fireEvent.change(within(form).getByLabelText('Текст отзыва'), { target: { value: 'Текст' } });
    fireEvent.click(within(form).getByRole('button', { name: 'Отправить отзыв' }));
    expect(await screen.findByText('Окно отзывов по этому проекту закрыто.')).toBeTruthy();
    code = 'NEW_CODE';
    fireEvent.click(within(form).getByRole('button', { name: 'Отправить отзыв' }));
    await waitFor(() => expect(screen.getByRole('alert').textContent).not.toMatch(/Окно отзывов/));
  });
});

describe('FR-PROF-08: the lists', () => {
  it('shows the received reviews without an author and with the date of the batch only', async () => {
    serve({
      received: [
        { id: 'r1', teamId: TEAM_ID, teamName: 'Команда Альфа', text: 'Надёжный коллега.', publishedOn: '2026-11-04' },
      ],
    });
    renderWithClient(<ReviewsPage />);
    const region = await screen.findByRole('region', { name: 'Отзывы обо мне' });
    expect(await within(region).findByText('Надёжный коллега.')).toBeTruthy();
    expect(region.textContent).toMatch(/Опубликовано 04\.11\.2026/);
    expect(region.textContent).not.toMatch(/\d{1,2}:\d{2}/);
  });

  it('says there are no reviews yet, and lists the sent ones by colleague name', async () => {
    serve({ sent: [{ subjectUserId: MEMBER_ID, status: 'sent' }] });
    renderWithClient(<ReviewsPage />);
    expect(await screen.findByText('Пока нет отзывов.')).toBeTruthy();
    const sent = await screen.findByRole('region', { name: 'Отправленные отзывы' });
    expect(within(sent).getByText('Борис Иванов: отправлено')).toBeTruthy();
  });

  it('formats a day as dd.mm.yyyy', () => {
    expect(formatDay('2026-11-04')).toBe('04.11.2026');
  });
});
