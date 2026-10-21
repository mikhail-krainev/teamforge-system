// @vitest-environment jsdom
import { cleanup, fireEvent, screen, waitFor } from '@testing-library/react';
import { HttpResponse, http } from 'msw';
import { setupServer } from 'msw/node';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { activeTeam, LEAD_ID, MEMBER_ID, TEAM_ID } from '@/features/route/fixtures';
import { problem } from '@/mocks/slice2/handlers';
import { API, renderWithClient } from '@/test/support';
import { GithubPage } from './GithubPage';
import { INSTALLATION_ID, sampleAvailable, sampleLink } from './fixtures';

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
const assign = vi.fn();
beforeEach(() => {
  assign.mockReset();
  Object.defineProperty(window, 'location', {
    configurable: true,
    value: { ...window.location, assign },
  });
});

interface Setup {
  meId?: string;
  link?: ReturnType<typeof sampleLink> | null;
  repositories?: ReturnType<typeof sampleAvailable>[];
}

function serve({ meId = LEAD_ID, link = null, repositories = [sampleAvailable()] }: Setup = {}) {
  server.use(
    http.get(`${API}/v1/me`, () => HttpResponse.json({ id: meId })),
    http.get(TEAM_URL, () => HttpResponse.json(activeTeam())),
    http.get(`${TEAM_URL}/repository`, () =>
      link ? HttpResponse.json(link) : problem(404, 'NOT_FOUND'),
    ),
    http.get(`${TEAM_URL}/github/available-repositories`, () =>
      HttpResponse.json({ items: repositories, nextCursor: null }),
    ),
  );
}

const open = (props: { installation?: string; error?: string } = {}) =>
  renderWithClient(<GithubPage teamId={TEAM_ID} {...props} />);

describe('FR-GH-01, FR-GH-11: installing the App', () => {
  it('shows the hint about Issues and the install button to the lead', async () => {
    serve();
    open();
    expect(
      await screen.findByRole('heading', { level: 1, name: 'Подключение GitHub' }),
    ).toBeTruthy();
    expect(screen.getByText('Ведите задачи как Issues', { exact: false })).toBeTruthy();
    expect(await screen.findByRole('button', { name: 'Установить App' })).toBeTruthy();
  });

  it('sends the browser to the https address of the installation session', async () => {
    serve();
    server.use(
      http.post(`${TEAM_URL}/github/installation-sessions`, () =>
        HttpResponse.json(
          {
            installUrl: 'https://github.com/apps/teamforge/installations/new?state=s1',
            expiresAt: '2026-02-01T10:10:00.000Z',
          },
          { status: 201 },
        ),
      ),
    );
    open();
    fireEvent.click(await screen.findByRole('button', { name: 'Установить App' }));
    await waitFor(() =>
      expect(assign).toHaveBeenCalledWith(
        'https://github.com/apps/teamforge/installations/new?state=s1',
      ),
    );
  });

  it('does not follow an install address that is not https', async () => {
    serve();
    server.use(
      http.post(`${TEAM_URL}/github/installation-sessions`, () =>
        HttpResponse.json(
          { installUrl: 'http://evil.example/x', expiresAt: '2026-02-01T10:10:00.000Z' },
          { status: 201 },
        ),
      ),
    );
    open();
    fireEvent.click(await screen.findByRole('button', { name: 'Установить App' }));
    expect(await screen.findByRole('alert')).toBeTruthy();
    expect(assign).not.toHaveBeenCalled();
  });

  it('tells a member that only the lead connects the repository', async () => {
    serve({ meId: MEMBER_ID });
    open();
    expect(
      await screen.findByText('Подключить репозиторий может только тимлид команды.'),
    ).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Установить App' })).toBeNull();
  });

  it('explains a failed return from GitHub in Russian', async () => {
    serve();
    open({ error: 'state_invalid' });
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain('Ссылка установки устарела');
  });
});

describe('FR-GH-01, FR-GH-02: choosing and binding the repository', () => {
  it('lists the repositories of the installation and binds the chosen one', async () => {
    serve({
      repositories: [
        sampleAvailable(),
        sampleAvailable({ repositoryId: 7, fullName: 'org/other' }),
      ],
    });
    let body: unknown;
    server.use(
      http.put(`${TEAM_URL}/repository`, async ({ request }) => {
        body = await request.json();
        return HttpResponse.json(sampleLink({ repositoryId: 7, fullName: 'org/other' }));
      }),
    );
    open({ installation: String(INSTALLATION_ID) });
    const group = await screen.findByRole('radiogroup', { name: 'Выберите репозиторий' });
    expect(group).toBeTruthy();
    const link = screen.getByRole('button', { name: 'Привязать репозиторий' }) as HTMLButtonElement;
    expect(link.disabled).toBe(true);
    fireEvent.click(screen.getByRole('radio', { name: /org\/other/ }));
    fireEvent.click(link);
    await waitFor(() => expect(screen.getByRole('status', { name: '' }).textContent).toBeDefined());
    expect(await screen.findByText('Репозиторий привязан: org/other')).toBeTruthy();
    expect(body).toEqual({ installationId: INSTALLATION_ID, repositoryId: 7 });
  });

  it('marks a repository that is not public and warns before binding it', async () => {
    serve({ repositories: [sampleAvailable({ private: true })] });
    open({ installation: String(INSTALLATION_ID) });
    const radio = await screen.findByRole('radio', { name: /Не публичный/ });
    fireEvent.click(radio);
    expect(screen.getByText('Публичность репозитория проверяется', { exact: false })).toBeTruthy();
  });

  it('REPO_TAKEN: says the repository belongs to another team and keeps the choice', async () => {
    serve();
    server.use(http.put(`${TEAM_URL}/repository`, () => problem(409, 'REPO_TAKEN')));
    open({ installation: String(INSTALLATION_ID) });
    fireEvent.click(await screen.findByRole('radio', { name: /teamforge-demo\/notes/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Привязать репозиторий' }));
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain('уже привязан к другой команде');
    expect((screen.getByRole('radio', { name: /notes/ }) as HTMLInputElement).checked).toBe(true);
  });

  it('REPO_REJECTED: names the reason when the server gives one (archived)', async () => {
    serve();
    server.use(
      http.put(`${TEAM_URL}/repository`, () =>
        problem(422, 'REPO_REJECTED', {
          errors: [{ pointer: '/repositoryId', code: 'REPO_ARCHIVED', message: 'x' }],
        }),
      ),
    );
    open({ installation: String(INSTALLATION_ID) });
    fireEvent.click(await screen.findByRole('radio', { name: /notes/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Привязать репозиторий' }));
    expect((await screen.findByRole('alert')).textContent).toContain('архивирован');
  });

  it('INSTALLATION_NOT_GRANTED: tells to install the App again', async () => {
    serve();
    server.use(
      http.get(`${TEAM_URL}/github/available-repositories`, () =>
        problem(404, 'INSTALLATION_NOT_GRANTED'),
      ),
    );
    open({ installation: String(INSTALLATION_ID) });
    expect((await screen.findByRole('alert')).textContent).toContain('Установите App заново');
  });
});

describe('FR-GH-07: the bound repository', () => {
  it('shows the bound repository with its warnings, and unlinks it after a confirmation', async () => {
    serve({ link: sampleLink({ warnings: ['repo_private'] }) });
    let deleted = false;
    server.use(
      http.delete(`${TEAM_URL}/repository`, () => {
        deleted = true;
        return new HttpResponse(null, { status: 204 });
      }),
    );
    open();
    expect(await screen.findByText('Репозиторий привязан: teamforge-demo/notes')).toBeTruthy();
    expect(screen.getByText('не публичный', { exact: false })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Отвязать репозиторий' }));
    expect(deleted).toBe(false);
    fireEvent.click(screen.getByRole('button', { name: 'Да, отвязать' }));
    await waitFor(() => expect(deleted).toBe(true));
  });

  it('shows an unlinked repository (the App was removed) and offers to install again', async () => {
    serve({ link: sampleLink({ status: 'unlinked' }) });
    open();
    expect(await screen.findByText('Репозиторий отвязан', { exact: false })).toBeTruthy();
    expect(await screen.findByRole('button', { name: 'Установить App' })).toBeTruthy();
  });

  it('gives a member no unlink button', async () => {
    serve({ meId: MEMBER_ID, link: sampleLink() });
    open();
    expect(await screen.findByText('Репозиторий привязан: teamforge-demo/notes')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Отвязать репозиторий' })).toBeNull();
  });
});

describe('loading and failures', () => {
  it('says the team is not available on 404', async () => {
    server.use(
      http.get(`${API}/v1/me`, () => HttpResponse.json({ id: LEAD_ID })),
      http.get(TEAM_URL, () => problem(404, 'NOT_FOUND')),
      http.get(`${TEAM_URL}/repository`, () => problem(404, 'NOT_FOUND')),
    );
    open();
    expect((await screen.findByRole('alert')).textContent).toContain('не найдена');
  });

  it('offers a retry when the load fails', async () => {
    server.use(
      http.get(`${API}/v1/me`, () => HttpResponse.json({ id: LEAD_ID })),
      http.get(TEAM_URL, () => problem(400, 'VALIDATION_FAILED')),
      http.get(`${TEAM_URL}/repository`, () => problem(404, 'NOT_FOUND')),
    );
    open();
    expect(await screen.findByRole('button', { name: 'Повторить' })).toBeTruthy();
  });
});
