// @vitest-environment jsdom
import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { HttpResponse, http } from 'msw';
import { setupServer } from 'msw/node';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { problem } from '@/mocks/slice2/handlers';
import { API, renderWithClient } from '@/test/support';
import { TEAM_ID } from '@/features/teams/fixtures';
import { AwardsBlock } from './AwardsBlock';
import { CreditPage } from './CreditPage';
import { currentSeriesSteps, formatCountdown } from './model';

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

const USER_ID = '0192f0a0-7c1e-7b3a-8d2f-00000000a0a1';
const DAY_MS = 86_400_000;
const ROLES = [{ code: 'backend', name: 'Backend-разработчик', active: true }];

const BADGES = [
  { code: 'projects_1', name: 'Первый релиз', series: 'projects', step: 1, scope: 'individual', available: true },
  { code: 'types_4', name: 'Коллекционер форматов', series: 'product_types', step: 4, scope: 'individual', available: false },
];

function serveAwards() {
  server.use(
    http.get(`${API}/v1/catalog/roles`, () => HttpResponse.json({ items: ROLES, nextCursor: null })),
    http.get(`${API}/v1/badges`, () => HttpResponse.json({ items: BADGES })),
    http.get(`${API}/v1/users/${USER_ID}/awards`, () =>
      HttpResponse.json({
        items: [
          {
            badgeCode: 'projects_1',
            name: 'Первый релиз',
            series: 'projects',
            step: 1,
            teamId: null,
            teamName: null,
            awardedAt: '2026-01-01T10:00:00.000Z',
          },
        ],
      }),
    ),
    http.get(`${API}/v1/users/${USER_ID}/counters`, () =>
      HttpResponse.json({ total: 1, byRole: [{ roleCode: 'backend', value: 1 }], productTypes: [] }),
    ),
  );
}

function award(
  badgeCode: string,
  name: string,
  series: string | null,
  step: number | null,
  awardedAt: string,
) {
  return { badgeCode, name, series, step, teamId: null, teamName: null, awardedAt };
}

describe('FR-REW-05, FR-PROF-06: the awards block', () => {
  it('shows the earned badge with its step, the counters and the catalogue states', async () => {
    serveAwards();
    renderWithClient(<AwardsBlock userId={USER_ID} />);
    const badges = await screen.findByRole('list', { name: 'Полученные значки' });
    const region = screen.getByRole('region', { name: 'Награды' });
    expect(within(badges).getByText('Первый релиз')).toBeTruthy();
    expect(within(badges).getByText('Ступень 1')).toBeTruthy();
    const counters = within(region).getByRole('region', { name: /счётчики/i });
    expect(counters.textContent).toMatch(/Зачтённых проектов: 1/);
    expect(counters.textContent).toMatch(/Backend-разработчик: 1/);
    const catalog = within(region).getByRole('region', { name: 'Каталог значков' });
    const closed = within(catalog)
      .getAllByRole('listitem')
      .find((item) => item.textContent?.includes('Коллекционер форматов'));
    expect(closed?.textContent).toMatch(/Недоступен/);
  });

  it('shows a series as one badge at its current step with the award date', async () => {
    serveAwards();
    server.use(
      http.get(`${API}/v1/users/${USER_ID}/awards`, () =>
        HttpResponse.json({
          items: [
            award('projects_1', 'Первый релиз', 'projects', 1, '2026-01-01T10:00:00.000Z'),
            award('projects_2', 'Трое в строю', 'projects', 2, '2026-03-05T10:00:00.000Z'),
            award('on_time', 'В срок', null, null, '2026-01-01T10:00:00.000Z'),
          ],
        }),
      ),
    );
    renderWithClient(<AwardsBlock userId={USER_ID} />);
    const badges = await screen.findByRole('list', { name: 'Полученные значки' });
    const items = within(badges).getAllByRole('listitem');
    expect(items).toHaveLength(2);
    expect(within(badges).queryByText('Первый релиз')).toBeNull();
    const series = items.find((item) => item.textContent?.includes('Трое в строю'));
    expect(series?.textContent).toMatch(/Ступень 2/);
    expect(series?.textContent).toMatch(/Получен 05\.03\.2026/);
    expect(within(badges).getByText('В срок')).toBeTruthy();
  });

  it('says so and offers a retry when the awards cannot be loaded', async () => {
    serveAwards();
    server.use(http.get(`${API}/v1/users/${USER_ID}/awards`, () => problem(403, 'FORBIDDEN')));
    renderWithClient(<AwardsBlock userId={USER_ID} />);
    expect(await screen.findByText('Не удалось загрузить награды.')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Повторить' })).toBeTruthy();
  });
});

describe('model', () => {
  it('keeps the highest step of each series and every badge outside a series', () => {
    const day = '2026-01-01T10:00:00.000Z';
    const list = [
      award('projects_2', 'Трое в строю', 'projects', 2, day),
      award('roles_1', 'Многоликий', 'roles', 1, day),
      award('projects_3', 'Пятёрка проектов', 'projects', 3, day),
      award('projects_1', 'Первый релиз', 'projects', 1, day),
      award('on_time', 'В срок', null, null, day),
    ];
    expect(currentSeriesSteps(list).map((item) => item.badgeCode)).toEqual([
      'roles_1',
      'projects_3',
      'on_time',
    ]);
  });

  it('counts the cooling down to the minute and stops at zero', () => {
    const now = new Date('2026-01-01T00:00:00Z');
    const until = new Date(now.getTime() + 6 * DAY_MS + 23 * 3_600_000 + 59 * 60_000).toISOString();
    expect(formatCountdown(until, now)).toBe('6 д 23 ч 59 мин');
    expect(formatCountdown(now.toISOString(), now)).toBeNull();
  });
});

function credit(status: string, coolingUntil: string, myCredits: unknown[] = []) {
  return http.get(`${API}/v1/teams/${TEAM_ID}/credit`, () =>
    HttpResponse.json({ teamId: TEAM_ID, status, coolingUntil, myCredits }),
  );
}

const IN_A_WEEK = () => new Date(Date.now() + 6.5 * DAY_MS).toISOString();
const LONG_AGO = () => new Date(Date.now() - 2 * DAY_MS).toISOString();

describe('FR-REW-11: the credit page', () => {
  it('shows the cooling with a countdown and no rule codes', async () => {
    server.use(
      http.get(`${API}/v1/catalog/roles`, () => HttpResponse.json({ items: ROLES, nextCursor: null })),
      credit('cooling', IN_A_WEEK()),
    );
    renderWithClient(<CreditPage teamId={TEAM_ID} />);
    expect(await screen.findByRole('heading', { level: 1, name: 'Зачёт проекта' })).toBeTruthy();
    expect(screen.getByRole('status', { name: 'Статус зачёта' }).textContent).toMatch(/охлаждение/i);
    expect(screen.getByRole('timer', { name: /до конца охлаждения/i }).textContent).toMatch(/\d/);
    expect(document.body.textContent).not.toMatch(/AF-\d\d/);
  });

  it('lists the own credits by role and hides the countdown and the complaint once credited', async () => {
    server.use(
      http.get(`${API}/v1/catalog/roles`, () => HttpResponse.json({ items: ROLES, nextCursor: null })),
      credit('credited', LONG_AGO(), [{ roleCode: 'backend', status: 'credited' }]),
    );
    renderWithClient(<CreditPage teamId={TEAM_ID} />);
    const list = await screen.findByRole('list', { name: 'Мой зачёт по ролям' });
    expect(within(list).getByText('Зачтено')).toBeTruthy();
    expect(screen.queryByRole('timer')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Оспорить проект' })).toBeNull();
  });

  it('files a complaint of at least 20 characters with an idempotency key, then confirms', async () => {
    const keys: (string | null)[] = [];
    server.use(
      http.get(`${API}/v1/catalog/roles`, () => HttpResponse.json({ items: ROLES, nextCursor: null })),
      credit('frozen', IN_A_WEEK()),
      http.post(`${API}/v1/teams/${TEAM_ID}/disputes`, ({ request }) => {
        keys.push(request.headers.get('Idempotency-Key'));
        return HttpResponse.json(
          { id: USER_ID, teamId: TEAM_ID, createdAt: new Date().toISOString() },
          { status: 201 },
        );
      }),
    );
    renderWithClient(<CreditPage teamId={TEAM_ID} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Оспорить проект' }));
    fireEvent.change(screen.getByLabelText('Причина жалобы'), { target: { value: 'коротко' } });
    fireEvent.click(screen.getByRole('button', { name: 'Отправить жалобу' }));
    expect(await screen.findByText(/не меньше 20 символов/)).toBeTruthy();
    expect(keys).toHaveLength(0);
    fireEvent.change(screen.getByLabelText('Причина жалобы'), {
      target: { value: 'Проект заморожен по ошибке, все задачи выполнены.' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Отправить жалобу' }));
    expect(await screen.findByText(/Жалоба отправлена/)).toBeTruthy();
    expect(keys).toHaveLength(1);
    expect(keys[0]).toBeTruthy();
  });

  it('explains a refusal after the cooling and shows the general error for an unknown code', async () => {
    let code = 'INVALID_STATE';
    server.use(
      http.get(`${API}/v1/catalog/roles`, () => HttpResponse.json({ items: ROLES, nextCursor: null })),
      credit('cooling', IN_A_WEEK()),
      http.post(`${API}/v1/teams/${TEAM_ID}/disputes`, () => problem(409, code)),
    );
    renderWithClient(<CreditPage teamId={TEAM_ID} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Оспорить проект' }));
    fireEvent.change(screen.getByLabelText('Причина жалобы'), {
      target: { value: 'Проект заморожен по ошибке, все задачи выполнены.' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Отправить жалобу' }));
    expect((await screen.findByRole('alert')).textContent).toMatch(/только в период охлаждения/);
    code = 'SOMETHING_NEW';
    fireEvent.click(await screen.findByRole('button', { name: 'Отправить жалобу' }));
    await waitFor(() => expect(screen.getByRole('alert').textContent).toMatch(/Жалоба уже подана/));
  });

  it('hides a project of somebody else (404) without saying it exists', async () => {
    server.use(
      http.get(`${API}/v1/catalog/roles`, () => HttpResponse.json({ items: ROLES, nextCursor: null })),
      http.get(`${API}/v1/teams/${TEAM_ID}/credit`, () => problem(404, 'NOT_FOUND')),
    );
    renderWithClient(<CreditPage teamId={TEAM_ID} />);
    expect(await screen.findByText(/не найден или у вас нет к нему доступа/)).toBeTruthy();
  });
});
