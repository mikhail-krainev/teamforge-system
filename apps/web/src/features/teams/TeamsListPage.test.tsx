// @vitest-environment jsdom
import { cleanup, fireEvent, screen, waitFor } from '@testing-library/react';
import { HttpResponse, http } from 'msw';
import { setupServer } from 'msw/node';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { problem } from '@/mocks/slice2/handlers';
import { API, renderWithClient } from '@/test/support';
import { PRODUCT_TYPES, ROLE_LIST, sampleSummary } from './fixtures';
import { TeamsListPage } from './TeamsListPage';

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

const EVIL = '<img src=x onerror=alert(1)>';
const queries: URLSearchParams[] = [];

function serveCatalogs(teams: Parameters<typeof http.get>[1]) {
  server.use(
    http.get(`${API}/v1/catalog/roles`, () =>
      HttpResponse.json({ items: ROLE_LIST, nextCursor: null }),
    ),
    http.get(`${API}/v1/product-types`, () => HttpResponse.json({ items: PRODUCT_TYPES })),
    http.get(`${API}/v1/teams`, teams),
  );
}

function serve() {
  queries.length = 0;
  serveCatalogs(({ request }) => {
    const params = new URL(request.url).searchParams;
    queries.push(params);
    if (params.get('cursor') === 'c2') {
      const second = sampleSummary({ id: '0192f0a0-7c1e-7b3a-8d2f-00000000a002', name: 'Вторая' });
      return HttpResponse.json({ items: [second], nextCursor: null });
    }
    return HttpResponse.json({ items: [sampleSummary({ name: EVIL })], nextCursor: 'c2' });
  });
}

describe('FR-TEAM-01: TeamsListPage', () => {
  it('lists teams, escapes names and links to the team page', async () => {
    serve();
    const { container } = renderWithClient(<TeamsListPage />);
    const link = await screen.findByRole('link', { name: EVIL });
    expect(link.getAttribute('href')).toBe('/teams/0192f0a0-7c1e-7b3a-8d2f-00000000a001');
    expect(container.querySelector('img')).toBeNull();
    expect(screen.getByText('Backend-разработчик · Junior')).toBeTruthy();
  });

  it('follows the cursor on "Показать ещё"', async () => {
    serve();
    renderWithClient(<TeamsListPage />);
    fireEvent.click(await screen.findByRole('button', { name: 'Показать ещё' }));
    expect(await screen.findByRole('link', { name: 'Вторая' })).toBeTruthy();
    expect(queries.at(-1)?.get('cursor')).toBe('c2');
    expect(screen.queryByRole('button', { name: 'Показать ещё' })).toBeNull();
  });

  it('sends the chosen filters', async () => {
    serve();
    renderWithClient(<TeamsListPage />);
    await screen.findByRole('option', { name: 'Веб-сервис' });
    fireEvent.change(screen.getByLabelText('Тип продукта'), { target: { value: 'web_service' } });
    fireEvent.change(screen.getByLabelText('Статус'), { target: { value: 'forming' } });
    fireEvent.change(screen.getByLabelText('Технология'), { target: { value: 'react' } });
    fireEvent.click(screen.getByRole('button', { name: 'Применить' }));
    await waitFor(() => expect(queries.at(-1)?.get('productType')).toBe('web_service'));
    expect(queries.at(-1)?.get('status')).toBe('forming');
    expect(queries.at(-1)?.get('stack')).toBe('react');
  });

  it('shows an empty state', async () => {
    serveCatalogs(() => HttpResponse.json({ items: [], nextCursor: null }));
    renderWithClient(<TeamsListPage />);
    expect(await screen.findByText(/Команд по этим условиям не нашлось/)).toBeTruthy();
  });

  it('reports a load failure as an alert', async () => {
    serveCatalogs(() => problem(403, 'FORBIDDEN'));
    renderWithClient(<TeamsListPage />);
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain('Не удалось загрузить список команд');
  });
});
