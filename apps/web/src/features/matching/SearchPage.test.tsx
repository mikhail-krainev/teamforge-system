// @vitest-environment jsdom
import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { HttpResponse, http } from 'msw';
import { setupServer } from 'msw/node';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { ROLE_LIST } from '@/features/teams/fixtures';
import { problem } from '@/mocks/slice2/handlers';
import { API, renderWithClient } from '@/test/support';
import { sampleApplication } from './fixtures';
import { SearchPage } from './SearchPage';

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

const APP_URL = `${API}/v1/me/search-application`;

function serve(application: unknown | null) {
  server.use(
    http.get(`${API}/v1/catalog/roles`, () =>
      HttpResponse.json({ items: ROLE_LIST, nextCursor: null }),
    ),
    http.get(`${API}/v1/me/recommended-teams`, () =>
      HttpResponse.json({ items: [], nextCursor: null }),
    ),
    http.get(APP_URL, () =>
      application ? HttpResponse.json(application) : problem(404, 'NOT_FOUND'),
    ),
  );
}

function pickRole(code: string) {
  fireEvent.change(screen.getByLabelText('Добавить роль'), { target: { value: code } });
}

describe('FR-MATCH-03: SearchPage, new application', () => {
  it('creates an application with priorities from the list order and one idempotency key', async () => {
    serve(null);
    let body: unknown;
    let key: string | null = null;
    server.use(
      http.post(APP_URL, async ({ request }) => {
        body = await request.json();
        key = request.headers.get('Idempotency-Key');
        return HttpResponse.json(sampleApplication(), { status: 201 });
      }),
    );
    renderWithClient(<SearchPage />);
    await screen.findByRole('heading', { name: 'Встать в очередь' });
    pickRole('backend');
    pickRole('qa');
    fireEvent.click(screen.getByRole('button', { name: 'Поднять роль Тестировщик выше' }));
    fireEvent.click(screen.getByRole('button', { name: 'Встать в очередь' }));
    expect(await screen.findByText('Ты в очереди')).toBeTruthy();
    expect(body).toEqual({
      roles: [
        { roleCode: 'qa', priority: 1 },
        { roleCode: 'backend', priority: 2 },
      ],
    });
    expect(key).toBeTruthy();
  });

  it('asks for at least one role without sending a request and focuses the role select', async () => {
    serve(null);
    renderWithClient(<SearchPage />);
    await screen.findByRole('heading', { name: 'Встать в очередь' });
    fireEvent.click(screen.getByRole('button', { name: 'Встать в очередь' }));
    expect(await screen.findByText('Выбери хотя бы одну роль.')).toBeTruthy();
    await waitFor(() => expect(document.activeElement?.id).toBe('application-role-add'));
  });

  it('limits the list to five roles', async () => {
    serve(null);
    renderWithClient(<SearchPage />);
    await screen.findByRole('heading', { name: 'Встать в очередь' });
    for (const code of ['pm', 'frontend', 'backend', 'mobile', 'designer']) pickRole(code);
    expect(screen.queryByLabelText('Добавить роль')).toBeNull();
  });

  it('GITHUB_REQUIRED is announced with a link to linking GitHub', async () => {
    serve(null);
    server.use(http.post(APP_URL, () => problem(409, 'GITHUB_REQUIRED')));
    renderWithClient(<SearchPage />);
    await screen.findByRole('heading', { name: 'Встать в очередь' });
    pickRole('backend');
    fireEvent.click(screen.getByRole('button', { name: 'Встать в очередь' }));
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain('привяжи GitHub');
    expect(within(alert).getByRole('link', { name: 'Привязать GitHub' })).toBeTruthy();
  });

  it('APPLICATION_EXISTS gets its own message', async () => {
    serve(null);
    server.use(http.post(APP_URL, () => problem(409, 'APPLICATION_EXISTS')));
    renderWithClient(<SearchPage />);
    await screen.findByRole('heading', { name: 'Встать в очередь' });
    pickRole('backend');
    fireEvent.click(screen.getByRole('button', { name: 'Встать в очередь' }));
    expect((await screen.findByRole('alert')).textContent).toContain('уже есть активная заявка');
  });

  it('shows the recommended teams block', async () => {
    serve(null);
    renderWithClient(<SearchPage />);
    expect(await screen.findByRole('heading', { name: 'Рекомендованные команды' })).toBeTruthy();
    expect(await screen.findByText(/Рекомендаций пока нет/)).toBeTruthy();
  });

  it('offers a retry when the application cannot be loaded', async () => {
    server.use(
      http.get(`${API}/v1/catalog/roles`, () =>
        HttpResponse.json({ items: ROLE_LIST, nextCursor: null }),
      ),
      http.get(APP_URL, () => problem(403, 'FORBIDDEN')),
    );
    renderWithClient(<SearchPage />);
    expect(await screen.findByText('Не получилось загрузить заявку в очереди.')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Повторить' })).toBeTruthy();
  });

});

describe('FR-MATCH-04: SearchPage, active application', () => {
  it('shows the status and the roles by priority with the change warning', async () => {
    serve(sampleApplication());
    renderWithClient(<SearchPage />);
    expect(await screen.findByText('Ты в очереди')).toBeTruthy();
    const list = screen.getByRole('list', { name: 'Роли по приоритету' });
    expect(within(list).getAllByRole('listitem').map((li) => li.textContent)).toEqual([
      '1. Backend-разработчик',
      '2. Тестировщик',
    ]);
    expect(screen.getByText(/новая роль встанет в очередь/)).toBeTruthy();
  });

  it('saves changed roles with the stored version', async () => {
    serve(sampleApplication());
    let body: unknown;
    server.use(
      http.put(APP_URL, async ({ request }) => {
        body = await request.json();
        return HttpResponse.json(
          sampleApplication({
            version: 3,
            roles: [{ roleCode: 'backend', priority: 1, addedAt: '2026-01-01T10:00:00.000Z' }],
          }),
        );
      }),
    );
    renderWithClient(<SearchPage />);
    await screen.findByText('Ты в очереди');
    fireEvent.click(screen.getByRole('button', { name: 'Убрать роль Тестировщик' }));
    fireEvent.click(screen.getByRole('button', { name: 'Сохранить изменения' }));
    expect(await screen.findByText('Заявка обновлена.')).toBeTruthy();
    expect(body).toEqual({ roles: [{ roleCode: 'backend', priority: 1 }], version: 2 });
  });

  it('VERSION_CONFLICT offers to keep my roles (with the current version) or take the stored ones', async () => {
    serve(sampleApplication());
    const bodies: unknown[] = [];
    const stored = sampleApplication({
      version: 5,
      roles: [{ roleCode: 'pm', priority: 1, addedAt: '2026-01-02T10:00:00.000Z' }],
    });
    server.use(
      http.put(APP_URL, async ({ request }) => {
        bodies.push(await request.json());
        return bodies.length === 1
          ? problem(409, 'VERSION_CONFLICT', { current: stored })
          : HttpResponse.json(sampleApplication({ version: 6 }));
      }),
    );
    renderWithClient(<SearchPage />);
    await screen.findByText('Ты в очереди');
    fireEvent.click(screen.getByRole('button', { name: 'Убрать роль Тестировщик' }));
    fireEvent.click(screen.getByRole('button', { name: 'Сохранить изменения' }));
    expect(await screen.findByText('Заявку изменили в другом месте')).toBeTruthy();
    expect(screen.getByText(/Актуальная версия заявки: 5\. Роли: Менеджер проекта/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Сохранить мои роли' }));
    await screen.findByText('Заявка обновлена.');
    expect(bodies[1]).toEqual({ roles: [{ roleCode: 'backend', priority: 1 }], version: 5 });
  });

  it('VERSION_CONFLICT: taking the stored application shows it right away (status card and form)', async () => {
    serve(sampleApplication());
    const stored = sampleApplication({
      version: 5,
      roles: [{ roleCode: 'pm', priority: 1, addedAt: '2026-01-02T10:00:00.000Z' }],
    });
    server.use(
      http.put(APP_URL, () => problem(409, 'VERSION_CONFLICT', { current: stored })),
    );
    renderWithClient(<SearchPage />);
    await screen.findByText('Ты в очереди');
    fireEvent.click(screen.getByRole('button', { name: 'Убрать роль Тестировщик' }));
    fireEvent.click(screen.getByRole('button', { name: 'Сохранить изменения' }));
    await screen.findByText('Заявку изменили в другом месте');
    fireEvent.click(screen.getByRole('button', { name: 'Взять актуальную заявку' }));
    await waitFor(() => expect(screen.queryByText('Заявку изменили в другом месте')).toBeNull());
    const list = screen.getByRole('list', { name: 'Роли по приоритету' });
    expect(within(list).getAllByRole('listitem').map((li) => li.textContent)).toEqual([
      '1. Менеджер проекта',
    ]);
  });

  it('cancels the application only after a confirmation', async () => {
    serve(sampleApplication());
    let deleted = false;
    server.use(
      http.delete(APP_URL, () => {
        deleted = true;
        return new HttpResponse(null, { status: 204 });
      }),
    );
    renderWithClient(<SearchPage />);
    await screen.findByText('Ты в очереди');
    fireEvent.click(screen.getByRole('button', { name: 'Выйти из очереди' }));
    expect(deleted).toBe(false);
    fireEvent.click(screen.getByRole('button', { name: 'Да, выйти из очереди' }));
    expect(await screen.findByText('Заявка отменена.')).toBeTruthy();
    expect(deleted).toBe(true);
    expect(screen.getByRole('button', { name: 'Встать в очередь' })).toBeTruthy();
  });
});
