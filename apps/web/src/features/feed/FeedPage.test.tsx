// @vitest-environment jsdom
import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { HttpResponse, http } from 'msw';
import { setupServer } from 'msw/node';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { activeTeam, LEAD_ID, MEMBER_ID, TEAM_ID } from '@/features/route/fixtures';
import type { Team } from '@/features/teams/api';
import { problem } from '@/mocks/slice2/handlers';
import { API, renderWithClient } from '@/test/support';
import { FeedPage } from './FeedPage';
import { sampleEntry, sampleSummary } from './fixtures';

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
  vi.unstubAllGlobals();
});
afterAll(() => server.close());

const TEAM_URL = `${API}/v1/teams/${TEAM_ID}`;
const ROLES = [
  { code: 'backend', name: 'Backend-разработчик', active: true },
  { code: 'devops', name: 'DevOps-инженер', active: true },
  { code: 'pm', name: 'Менеджер проекта', active: true },
];

/** Boris holds two roles, so he can relabel his contributions. */
function teamOfTwoRoles(): Team {
  const team = activeTeam();
  return {
    ...team,
    members: team.members.map((m) =>
      m.userId === MEMBER_ID ? { ...m, roles: ['backend', 'devops'] } : m,
    ),
  };
}

interface Setup {
  meId?: string;
  team?: Team;
  pages?: { items: ReturnType<typeof sampleEntry>[]; nextCursor: string | null }[];
}

/** Serves the feed; `requests` records the query of every feed call. */
function serve({ meId = MEMBER_ID, team = teamOfTwoRoles(), pages }: Setup = {}) {
  const requests: URLSearchParams[] = [];
  const feedPages = pages ?? [{ items: [sampleEntry()], nextCursor: null }];
  server.use(
    http.get(`${API}/v1/me`, () => HttpResponse.json({ id: meId })),
    http.get(`${API}/v1/catalog/roles`, () =>
      HttpResponse.json({ items: ROLES, nextCursor: null }),
    ),
    http.get(TEAM_URL, () => HttpResponse.json(team)),
    http.get(`${TEAM_URL}/contributions/summary`, () => HttpResponse.json(sampleSummary())),
    http.get(`${TEAM_URL}/feed`, ({ request }) => {
      const query = new URL(request.url).searchParams;
      requests.push(query);
      const cursor = query.get('cursor');
      const index = cursor ? Number(cursor.replace('c', '')) : 0;
      return HttpResponse.json(feedPages[index] ?? { items: [], nextCursor: null });
    }),
  );
  return requests;
}

const open = () => renderWithClient(<FeedPage teamId={TEAM_ID} />);

describe('FR-WORK-16: the feed', () => {
  it('lists the records with the executor, the role and the source', async () => {
    serve();
    open();
    expect(
      await screen.findByRole('heading', { level: 1, name: 'Лента задач и вклад' }),
    ).toBeTruthy();
    const list = await screen.findByRole('list', { name: 'Лента задач' });
    const entry = within(list).getByRole('listitem');
    expect(
      within(entry)
        .getByRole('link', { name: /Доработать API/ })
        .getAttribute('href'),
    ).toBe('https://github.com/teamforge-demo/notes/issues/12');
    expect(entry.textContent).toContain('Исполнитель: Борис Иванов');
    expect(entry.textContent).toContain('Backend-разработчик');
    expect(entry.textContent).toContain('Issue');
  });

  it('shows a title without a link when the address is not https', async () => {
    serve({ pages: [{ items: [sampleEntry({ url: 'javascript:alert(1)' })], nextCursor: null }] });
    open();
    const list = await screen.findByRole('list', { name: 'Лента задач' });
    expect(within(list).queryByRole('link')).toBeNull();
    expect(within(list).getByText('Доработать API')).toBeTruthy();
  });

  it('filters by executor and source: the filter goes to the server and the list starts over', async () => {
    const requests = serve();
    open();
    await screen.findByRole('list', { name: 'Лента задач' });
    fireEvent.change(screen.getByLabelText('Исполнитель'), { target: { value: LEAD_ID } });
    fireEvent.change(screen.getByLabelText('Источник'), { target: { value: 'pr' } });
    await waitFor(() => {
      const last = requests.at(-1);
      expect(last?.get('userId')).toBe(LEAD_ID);
      expect(last?.get('source')).toBe('pr');
      expect(last?.get('cursor')).toBeNull();
    });
  });

  it('loads the next page by the cursor with the button', async () => {
    const requests = serve({
      pages: [
        { items: [sampleEntry()], nextCursor: 'c1' },
        {
          items: [sampleEntry({ id: 'e2', title: 'PR: страница', source: 'pr' })],
          nextCursor: null,
        },
      ],
    });
    open();
    fireEvent.click(await screen.findByRole('button', { name: 'Показать ещё' }));
    expect(await screen.findByText('PR: страница')).toBeTruthy();
    expect(requests.at(-1)?.get('cursor')).toBe('c1');
    expect(screen.queryByRole('button', { name: 'Показать ещё' })).toBeNull();
  });

  it('loads the next page when the end of the list scrolls into view', async () => {
    let notify: ((entries: { isIntersecting: boolean }[]) => void) | undefined;
    vi.stubGlobal(
      'IntersectionObserver',
      class {
        constructor(callback: (entries: { isIntersecting: boolean }[]) => void) {
          notify = callback;
        }
        observe() {}
        disconnect() {}
      },
    );
    const requests = serve({
      pages: [
        { items: [sampleEntry()], nextCursor: 'c1' },
        { items: [sampleEntry({ id: 'e2', title: 'Вторая страница' })], nextCursor: null },
      ],
    });
    open();
    await screen.findByRole('button', { name: 'Показать ещё' });
    await waitFor(() => expect(notify).toBeDefined());
    notify?.([{ isIntersecting: true }]);
    expect(await screen.findByText('Вторая страница')).toBeTruthy();
    expect(requests.at(-1)?.get('cursor')).toBe('c1');
  });

  it('shows an empty feed with a way to connect the repository', async () => {
    serve({ pages: [{ items: [], nextCursor: null }] });
    open();
    expect(await screen.findByText('В ленте пока пусто', { exact: false })).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Подключить репозиторий' }).getAttribute('href')).toBe(
      `/teams/${TEAM_ID}/github`,
    );
  });

  it('offers a retry when the feed fails to load', async () => {
    serve();
    server.use(http.get(`${TEAM_URL}/feed`, () => problem(400, 'VALIDATION_FAILED')));
    open();
    const alerts = await screen.findAllByRole('alert');
    expect(alerts.some((a) => a.textContent?.includes('Не получилось загрузить ленту'))).toBe(true);
  });

  it('says the team is not available for an outsider (404)', async () => {
    server.use(
      http.get(`${API}/v1/me`, () => HttpResponse.json({ id: MEMBER_ID })),
      http.get(`${API}/v1/catalog/roles`, () =>
        HttpResponse.json({ items: ROLES, nextCursor: null }),
      ),
      http.get(TEAM_URL, () => problem(404, 'NOT_FOUND')),
    );
    open();
    expect((await screen.findByRole('alert')).textContent).toContain('не найдена');
  });
});

describe('FR-WORK-16: the contribution summary', () => {
  it('shows the contributions of each member by role', async () => {
    serve();
    open();
    const region = await screen.findByRole('heading', { level: 2, name: 'Вклад участников' });
    const table = await within(region.closest('section') as HTMLElement).findByRole('table');
    const rows = within(table).getAllByRole('row');
    expect(rows).toHaveLength(4);
    expect(rows[1]?.textContent).toContain('Борис Иванов');
    expect(rows[1]?.textContent).toContain('Backend-разработчик');
    expect(rows[1]?.textContent).toContain('3');
  });
});

describe('FR-WORK-17: the role of a contribution', () => {
  it('relabels only after a confirmation, choosing among the own roles', async () => {
    serve();
    const bodies: unknown[] = [];
    server.use(
      http.patch(`${TEAM_URL}/contributions/${sampleEntry().id}`, async ({ request }) => {
        bodies.push(await request.json());
        return HttpResponse.json(sampleEntry({ roleCode: 'devops' }));
      }),
    );
    open();
    fireEvent.click(await screen.findByRole('button', { name: 'Сменить роль' }));
    const select = screen.getByLabelText('Новая роль') as HTMLSelectElement;
    expect([...select.options].map((o) => o.value)).toEqual(['devops']);
    expect(bodies).toHaveLength(0);
    fireEvent.click(screen.getByRole('button', { name: 'Подтвердить' }));
    await waitFor(() => expect(bodies).toEqual([{ roleCode: 'devops' }]));
    await waitFor(() => expect(screen.queryByLabelText('Новая роль')).toBeNull());
  });

  it('cancelling sends nothing', async () => {
    serve();
    let sent = false;
    server.use(
      http.patch(`${TEAM_URL}/contributions/${sampleEntry().id}`, () => {
        sent = true;
        return HttpResponse.json(sampleEntry());
      }),
    );
    open();
    fireEvent.click(await screen.findByRole('button', { name: 'Сменить роль' }));
    fireEvent.click(screen.getByRole('button', { name: 'Отмена' }));
    expect(screen.getByRole('button', { name: 'Сменить роль' })).toBeTruthy();
    expect(sent).toBe(false);
  });

  it('shows why the role was not changed (the project is completed)', async () => {
    serve();
    server.use(
      http.patch(`${TEAM_URL}/contributions/${sampleEntry().id}`, () =>
        problem(409, 'INVALID_STATE'),
      ),
    );
    open();
    fireEvent.click(await screen.findByRole('button', { name: 'Сменить роль' }));
    fireEvent.click(screen.getByRole('button', { name: 'Подтвердить' }));
    expect((await screen.findByRole('alert')).textContent).toContain('проект завершён');
  });

  it('gives no button on the entry of somebody else, or to a member with one role', async () => {
    serve({ meId: LEAD_ID });
    open();
    await screen.findByRole('list', { name: 'Лента задач' });
    expect(screen.queryByRole('button', { name: 'Сменить роль' })).toBeNull();
    cleanup();
    serve({ meId: MEMBER_ID, team: activeTeam() });
    open();
    await screen.findByRole('list', { name: 'Лента задач' });
    expect(screen.queryByRole('button', { name: 'Сменить роль' })).toBeNull();
  });

  it('gives no button once the project is completed', async () => {
    serve({ team: { ...teamOfTwoRoles(), status: 'completed' } });
    open();
    await screen.findByRole('list', { name: 'Лента задач' });
    expect(screen.queryByRole('button', { name: 'Сменить роль' })).toBeNull();
  });
});
