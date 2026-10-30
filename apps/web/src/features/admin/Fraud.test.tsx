// @vitest-environment jsdom
import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { HttpResponse, http } from 'msw';
import { setupServer } from 'msw/node';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { TEAM_ID } from '@/features/teams/fixtures';
import { problem } from '@/mocks/slice2/handlers';
import { API, renderWithClient } from '@/test/support';
import { FraudCasePage } from './FraudCasePage';
import { FraudQueuePage } from './FraudQueuePage';

const replace = vi.fn();
vi.mock('next/navigation', () => ({ useRouter: () => ({ replace }) }));
vi.mock('next/link', () => ({
  default: ({ href, children }: { href: string; children: React.ReactNode }) => (
    <a href={href}>{children}</a>
  ),
}));
vi.mock('@/lib/api/client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/api/client')>();
  return { ...actual, apiClient: actual.createApiClient({ baseUrl: 'http://localhost/api' }) };
});

const server = setupServer();
beforeAll(() => server.listen({ onUnhandledFrame: 'error' }));
afterEach(() => {
  cleanup();
  replace.mockClear();
  server.resetHandlers();
});
afterAll(() => server.close());

const CASE_ID = '0192f0a0-7c1e-7b3a-8d2f-00000000f001';
const COMMENT = 'Pull request-ы формальные, вклад не подтверждён.';

const openCase = {
  id: CASE_ID,
  teamId: TEAM_ID,
  teamName: 'Команда Бета',
  status: 'open',
  openedAt: '2026-11-01T10:00:00.000Z',
  signals: [{ ruleCode: 'AF-05', phase: 'completion', score: 3, action: 'flag' }],
  disputes: [{ text: 'Проект заморожен по ошибке.', createdAt: '2026-11-02T10:00:00.000Z' }],
  decidedAt: null,
  comment: null,
};

function serveMe(isAdmin: boolean) {
  server.use(http.get(`${API}/v1/me`, () => HttpResponse.json({ id: 'me', isAdmin })));
}

describe('FR-REW-16: the queue', () => {
  it('sends a non-administrator away without asking the api for the cases', async () => {
    serveMe(false);
    renderWithClient(<FraudQueuePage />);
    await waitFor(() => expect(replace).toHaveBeenCalledWith('/'));
    expect(screen.queryByRole('heading', { level: 1 })).toBeNull();
  });

  it('lists the open cases with a link to each', async () => {
    serveMe(true);
    server.use(
      http.get(`${API}/v1/admin/fraud-cases`, () =>
        HttpResponse.json({ items: [openCase], nextCursor: null }),
      ),
    );
    renderWithClient(<FraudQueuePage />);
    const list = await screen.findByRole('list', { name: 'Дела на проверке' });
    const link = within(list).getByRole('link', { name: 'Открыть дело' });
    expect(link.getAttribute('href')).toBe(`/admin/fraud/${CASE_ID}`);
    expect(within(list).getByText('Команда Бета')).toBeTruthy();
  });
});

describe('FR-REW-16, AF-25: the decision', () => {
  it('shows the rules and the complaints, and decides only after a confirmation', async () => {
    serveMe(true);
    const bodies: unknown[] = [];
    // The panel reads the card again after the decision, so the server keeps the decided case.
    let current: Record<string, unknown> = openCase;
    server.use(
      http.get(`${API}/v1/admin/fraud-cases/${CASE_ID}`, () => HttpResponse.json(current)),
      http.post(`${API}/v1/admin/fraud-cases/${CASE_ID}/decision`, async ({ request }) => {
        bodies.push(await request.json());
        current = { ...openCase, status: 'violation', comment: COMMENT };
        return HttpResponse.json(current);
      }),
    );
    renderWithClient(<FraudCasePage caseId={CASE_ID} />);
    const card = await screen.findByRole('region', { name: 'Карточка дела' });
    expect(within(card).getByRole('list', { name: 'Сработавшие правила' }).textContent).toMatch(
      /AF-05/,
    );
    expect(within(card).getByRole('list', { name: 'Жалобы участников' }).textContent).toMatch(
      /заморожен по ошибке/,
    );

    fireEvent.click(within(card).getByRole('button', { name: 'Решение: нарушение' }));
    expect(await within(card).findByText(/не короче 10 символов/)).toBeTruthy();
    expect(screen.queryByRole('dialog')).toBeNull();

    fireEvent.change(within(card).getByLabelText('Комментарий'), { target: { value: COMMENT } });
    fireEvent.click(within(card).getByRole('button', { name: 'Решение: нарушение' }));
    const dialog = await screen.findByRole('dialog', { name: 'Подтвердите решение' });
    expect(bodies).toHaveLength(0);
    fireEvent.click(within(dialog).getByRole('button', { name: 'Подтвердить' }));
    const done = await within(card).findByRole('status');
    expect(done.textContent).toMatch(/Решение принято: Нарушение/);
    expect(bodies).toEqual([{ decision: 'violation', comment: COMMENT }]);
  });

  it('lists a rule that fired in both phases twice without a duplicate key', async () => {
    serveMe(true);
    const twice = {
      ...openCase,
      signals: [
        { ruleCode: 'AF-05', phase: 'completion', score: 3, action: 'flag' },
        { ruleCode: 'AF-05', phase: 'cooling_end', score: 3, action: 'flag' },
      ],
    };
    server.use(http.get(`${API}/v1/admin/fraud-cases/${CASE_ID}`, () => HttpResponse.json(twice)));
    const errors = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      renderWithClient(<FraudCasePage caseId={CASE_ID} />);
      const rules = await screen.findByRole('list', { name: 'Сработавшие правила' });
      expect(within(rules).getAllByRole('listitem')).toHaveLength(2);
      const keyWarnings = errors.mock.calls.filter((call) => String(call[0]).includes('same key'));
      expect(keyWarnings).toEqual([]);
    } finally {
      errors.mockRestore();
    }
  });

  it('closes the confirmation with Escape without deciding', async () => {
    serveMe(true);
    server.use(
      http.get(`${API}/v1/admin/fraud-cases/${CASE_ID}`, () => HttpResponse.json(openCase)),
    );
    renderWithClient(<FraudCasePage caseId={CASE_ID} />);
    const card = await screen.findByRole('region', { name: 'Карточка дела' });
    fireEvent.change(within(card).getByLabelText('Комментарий'), { target: { value: COMMENT } });
    fireEvent.click(within(card).getByRole('button', { name: 'Решение: в порядке' }));
    const dialog = await screen.findByRole('dialog', { name: 'Подтвердите решение' });
    fireEvent.keyDown(dialog, { key: 'Escape' });
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('tells that the case is already decided on a 409 INVALID_STATE', async () => {
    serveMe(true);
    server.use(
      http.get(`${API}/v1/admin/fraud-cases/${CASE_ID}`, () => HttpResponse.json(openCase)),
      http.post(`${API}/v1/admin/fraud-cases/${CASE_ID}/decision`, () =>
        problem(409, 'INVALID_STATE'),
      ),
    );
    renderWithClient(<FraudCasePage caseId={CASE_ID} />);
    const card = await screen.findByRole('region', { name: 'Карточка дела' });
    fireEvent.change(within(card).getByLabelText('Комментарий'), { target: { value: COMMENT } });
    fireEvent.click(within(card).getByRole('button', { name: 'Решение: в порядке' }));
    const dialog = await screen.findByRole('dialog', { name: 'Подтвердите решение' });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Подтвердить' }));
    expect(await within(dialog).findByText('По этому делу решение уже принято.')).toBeTruthy();
  });
});
