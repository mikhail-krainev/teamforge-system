// @vitest-environment jsdom
import { cleanup, fireEvent, screen, waitFor } from '@testing-library/react';
import { HttpResponse, http } from 'msw';
import { setupServer } from 'msw/node';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { problem } from '@/mocks/slice2/handlers';
import { API, renderWithClient } from '@/test/support';
import { CreateTeamForm } from './CreateTeamForm';
import { PRODUCT_TYPES, ROLE_LIST, TEAM_ID, sampleTeam } from './fixtures';

const push = vi.fn();
vi.mock('next/navigation', () => ({ useRouter: () => ({ push }) }));
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
  push.mockReset();
});
afterAll(() => server.close());

function serve(onCreate: (request: Request) => Response | Promise<Response>) {
  server.use(
    http.get(`${API}/v1/catalog/roles`, () =>
      HttpResponse.json({ items: ROLE_LIST, nextCursor: null }),
    ),
    http.get(`${API}/v1/product-types`, () => HttpResponse.json({ items: PRODUCT_TYPES })),
    http.post(`${API}/v1/teams`, ({ request }) => onCreate(request)),
  );
}
const submit = () => fireEvent.click(screen.getByRole('button', { name: 'Создать команду' }));
const nameField = () => screen.getByLabelText(/Название команды/);

async function fillValid() {
  await screen.findByRole('option', { name: 'Веб-сервис' });
  fireEvent.change(nameField(), { target: { value: 'Альфа' } });
  fireEvent.change(screen.getByLabelText(/Тип продукта/), { target: { value: 'web_service' } });
}

describe('FR-TEAM-01: CreateTeamForm', () => {
  it('focuses the first invalid field and marks it invalid', async () => {
    serve(() => HttpResponse.json(sampleTeam(), { status: 201 }));
    renderWithClient(<CreateTeamForm />);
    await screen.findByRole('option', { name: 'Веб-сервис' });
    submit();
    await waitFor(() => expect(document.activeElement).toBe(nameField()));
    expect(nameField().getAttribute('aria-invalid')).toBe('true');
    expect(screen.getByRole('alert').textContent).toContain('Поправь отмеченные поля');
  });

  it('creates the team with an Idempotency-Key and opens it', async () => {
    let key: string | null = null;
    let body: unknown;
    serve(async (request) => {
      key = request.headers.get('Idempotency-Key');
      body = await request.json();
      return HttpResponse.json(sampleTeam(), { status: 201 });
    });
    renderWithClient(<CreateTeamForm />);
    await fillValid();
    fireEvent.click(screen.getByRole('button', { name: 'Добавить место' }));
    fireEvent.change(screen.getByLabelText(/^Роль/), { target: { value: 'backend' } });
    submit();
    await waitFor(() => expect(push).toHaveBeenCalledWith(`/teams/${TEAM_ID}`));
    expect(key).toMatch(/^[0-9a-f-]{36}$/);
    expect(body).toMatchObject({
      productTypeCode: 'web_service',
      seats: [{ roleCode: 'backend', count: 1 }],
    });
  });

  it('disables the button while the request runs', async () => {
    let release: () => void = () => undefined;
    let started = false;
    serve(
      () =>
        new Promise<Response>((resolve) => {
          started = true;
          release = () => resolve(HttpResponse.json(sampleTeam(), { status: 201 }));
        }),
    );
    renderWithClient(<CreateTeamForm />);
    await fillValid();
    submit();
    const pending = await screen.findByRole('button', { name: 'Создаём…' });
    expect((pending as HTMLButtonElement).disabled).toBe(true);
    await waitFor(() => expect(started).toBe(true));
    release();
    await waitFor(() => expect(push).toHaveBeenCalled());
  });

  it('GITHUB_REQUIRED explains and links to GitHub linking', async () => {
    serve(() => problem(409, 'GITHUB_REQUIRED'));
    renderWithClient(<CreateTeamForm />);
    await fillValid();
    submit();
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain('привяжи GitHub');
    const link = screen.getByRole('link', { name: 'Привязать GitHub' });
    expect(link.getAttribute('href')).toBe('/settings');
    expect(push).not.toHaveBeenCalled();
  });

  it('PROJECT_LIMIT shows its own message', async () => {
    serve(() => problem(409, 'PROJECT_LIMIT'));
    renderWithClient(<CreateTeamForm />);
    await fillValid();
    submit();
    expect((await screen.findByRole('alert')).textContent).toContain('максимальном числе команд');
  });

  it('a server 422 marks and focuses the rejected field', async () => {
    serve(() =>
      problem(422, 'VALIDATION_FAILED', { errors: [{ pointer: '/name', message: 'bad' }] }),
    );
    renderWithClient(<CreateTeamForm />);
    await fillValid();
    submit();
    await waitFor(() => expect(nameField().getAttribute('aria-invalid')).toBe('true'));
    await waitFor(() => expect(document.activeElement).toBe(nameField()));
  });
});
