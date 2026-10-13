// @vitest-environment jsdom
import { cleanup, screen, waitFor } from '@testing-library/react';
import { HttpResponse, http } from 'msw';
import { setupServer } from 'msw/node';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { ROLES } from '@/mocks/slice2/db';
import { problem } from '@/mocks/slice2/handlers';
import { API, renderWithClient, sampleUpload, type ResumeUpload } from '@/test/support';
import { ResumeSection } from './ResumeSection';

vi.mock('@/lib/api/client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/api/client')>();
  return { ...actual, apiClient: actual.createApiClient({ baseUrl: 'http://localhost/api' }) };
});
// A short poll interval keeps the real-timer test fast.
vi.mock('./api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./api')>()),
  POLL_MS: 20,
}));

const RESUME_URL = `${API}/v1/me/resume`;
const server = setupServer(
  http.get(`${API}/v1/catalog/roles`, () => HttpResponse.json({ items: ROLES, nextCursor: null })),
);
beforeAll(() => server.listen({ onUnhandledFrame: 'error' }));
afterEach(() => {
  cleanup();
  server.resetHandlers();
});
afterAll(() => server.close());

const status = () => screen.getByRole('status', { name: 'Статус разбора' });

describe('ResumeSection', () => {
  it('polls while the parser works, announces each status in the live region and stops when done', async () => {
    const answers: ResumeUpload[] = [
      sampleUpload({ status: 'queued' }),
      sampleUpload({ status: 'processing' }),
      sampleUpload({ status: 'done', suggestions: { displayName: 'Мария' } }),
    ];
    let polls = 0;
    server.use(
      http.get(RESUME_URL, () => {
        polls += 1;
        return HttpResponse.json(answers[Math.min(polls, answers.length) - 1]);
      }),
    );
    renderWithClient(<ResumeSection profileVersion={1} onProfileChanged={vi.fn()} />);
    expect(status().getAttribute('aria-live')).toBe('polite');
    await waitFor(() => expect(status().textContent).toContain('в очереди'));
    await waitFor(() => expect(status().textContent).toContain('Разбираем резюме'));
    await waitFor(() => expect(status().textContent).toContain('Разбор завершён'));
    expect(screen.getByRole('button', { name: 'Подтвердить выбранные поля' })).toBeTruthy();
    const settled = polls;
    await new Promise((resolve) => setTimeout(resolve, 120));
    expect(polls).toBe(settled);
  });

  it('keeps showing the last status and says so when a poll fails', async () => {
    let polls = 0;
    server.use(
      http.get(RESUME_URL, () => {
        polls += 1;
        return polls === 1
          ? HttpResponse.json(sampleUpload({ status: 'processing' }))
          : problem(403, 'FORBIDDEN');
      }),
    );
    renderWithClient(<ResumeSection profileVersion={1} onProfileChanged={vi.fn()} />);
    await screen.findByText('Не удалось обновить статус. Повторяем попытку.');
    expect(status().textContent).toContain('Разбираем резюме');
  });

  it('explains why a failed parse failed and offers a new upload', async () => {
    server.use(
      http.get(RESUME_URL, () =>
        HttpResponse.json(sampleUpload({ status: 'failed', failureReason: 'scan_without_text' })),
      ),
    );
    renderWithClient(<ResumeSection profileVersion={1} onProfileChanged={vi.fn()} />);
    await waitFor(() => expect(status().textContent).toContain('похоже на скан'));
    expect(screen.getByRole('button', { name: 'Загрузить' })).toBeTruthy();
  });

  it('offers an upload when there is no resume (404)', async () => {
    server.use(http.get(RESUME_URL, () => problem(404, 'NOT_FOUND')));
    renderWithClient(<ResumeSection profileVersion={1} onProfileChanged={vi.fn()} />);
    expect(await screen.findByRole('button', { name: 'Загрузить' })).toBeTruthy();
    expect(status().textContent).toBe('');
  });
});
