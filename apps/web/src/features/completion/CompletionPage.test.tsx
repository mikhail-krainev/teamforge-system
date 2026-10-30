// @vitest-environment jsdom
import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { HttpResponse, http } from 'msw';
import { setupServer } from 'msw/node';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { sampleSummary } from '@/features/feed/fixtures';
import {
  activeTeam,
  LEAD_ID,
  MEMBER_ID,
  sampleItem,
  sampleStage,
  TEAM_ID,
} from '@/features/route/fixtures';
import type { Team } from '@/features/teams/api';
import { problem } from '@/mocks/slice2/handlers';
import { API, renderWithClient } from '@/test/support';
import type { CompletionCheck } from './api';
import { CompletionPage } from './CompletionPage';
import { resultData, sampleCheck, sampleCompletion } from './fixtures';

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
const FINAL_ITEM = sampleItem({
  id: '0192f0a0-7c1e-7b3a-8d2f-00000000d0f1',
  stageOrdinal: 3,
  stepKey: 'mini_final_links',
  title: 'Финальные ссылки',
  kind: 'artifact',
  submission: 'link',
  ritualKind: null,
  ownerRole: 'any',
});
const ROLES = [
  { code: 'backend', name: 'Backend-разработчик', active: true },
  { code: 'pm', name: 'Менеджер проекта', active: true },
];

interface Setup {
  meId?: string;
  team?: Team;
  latest?: CompletionCheck | null;
}

function serve({ meId = LEAD_ID, team = activeTeam(), latest = null }: Setup = {}) {
  let current = team;
  server.use(
    http.get(`${API}/v1/me`, () => HttpResponse.json({ id: meId })),
    http.get(`${API}/v1/catalog/roles`, () =>
      HttpResponse.json({ items: ROLES, nextCursor: null }),
    ),
    http.get(TEAM_URL, () => HttpResponse.json(current)),
    http.get(`${TEAM_URL}/stages`, () =>
      HttpResponse.json({
        items: [
          sampleStage({ ordinal: 1, status: 'closed' }),
          sampleStage({ ordinal: 3, key: 'mini_s3', title: 'Этап 3. Релиз' }),
        ],
        plannedEndAt: null,
      }),
    ),
    http.get(`${TEAM_URL}/stages/3/checklist`, () => HttpResponse.json({ items: [FINAL_ITEM] })),
    http.get(`${TEAM_URL}/completion-checks/latest`, () =>
      latest ? HttpResponse.json(latest) : problem(404, 'NOT_FOUND'),
    ),
    http.get(`${TEAM_URL}/contributions/summary`, () => HttpResponse.json(sampleSummary())),
  );
  return { complete: (next: Team) => (current = next) };
}

const open = () => renderWithClient(<CompletionPage teamId={TEAM_ID} />);

describe('FR-WORK-13, FR-WORK-14: the wizard', () => {
  it('shows the steps to the lead: stages, release link, checks', async () => {
    serve();
    open();
    expect(
      await screen.findByRole('heading', { level: 1, name: 'Завершение проекта' }),
    ).toBeTruthy();
    expect(await screen.findByText('Закрыто этапов: 1 из 2')).toBeTruthy();
    expect(await screen.findByLabelText('Ссылка на релиз')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Запустить проверки' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Завершить проект' }).hasAttribute('disabled')).toBe(
      true,
    );
  });

  it('saves the release link through the final-links step with its version', async () => {
    serve();
    const bodies: unknown[] = [];
    server.use(
      http.patch(`${TEAM_URL}/checklist-items/${FINAL_ITEM.id}`, async ({ request }) => {
        bodies.push(await request.json());
        return HttpResponse.json({
          ...FINAL_ITEM,
          linkUrl: 'https://notes.example.org',
          version: 4,
        });
      }),
    );
    open();
    fireEvent.change(await screen.findByLabelText('Ссылка на релиз'), {
      target: { value: 'https://notes.example.org' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Сохранить ссылку' }));
    await waitFor(() =>
      expect(bodies).toEqual([
        { linkUrl: 'https://notes.example.org', version: FINAL_ITEM.version },
      ]),
    );
    expect(await screen.findByText('Ссылка сохранена', { exact: false })).toBeTruthy();
  });

  it('refuses a link that is not https without sending it', async () => {
    serve();
    let sent = false;
    server.use(
      http.patch(`${TEAM_URL}/checklist-items/${FINAL_ITEM.id}`, () => {
        sent = true;
        return HttpResponse.json(FINAL_ITEM);
      }),
    );
    open();
    fireEvent.change(await screen.findByLabelText('Ссылка на релиз'), {
      target: { value: 'http://notes.example.org' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Сохранить ссылку' }));
    expect(await screen.findByText('Подходят только ссылки по https.')).toBeTruthy();
    expect(sent).toBe(false);
  });

  it('runs the checks and lists each with its status, reason code and the second-check note', async () => {
    serve();
    server.use(
      http.post(`${TEAM_URL}/completion-checks`, () =>
        HttpResponse.json(
          sampleCheck({
            results: [
              { key: 'repo_final', ok: true, blocking: true, message: 'ok' },
              {
                key: 'release_alive_web',
                ok: false,
                blocking: true,
                message: 'x',
                data: resultData({ reason: 'TOO_SMALL', httpStatus: 200 }),
              },
            ],
          }),
          { status: 202 },
        ),
      ),
    );
    open();
    fireEvent.click(await screen.findByRole('button', { name: 'Запустить проверки' }));
    const list = await screen.findByRole('list', { name: 'Проверки готовности' });
    const items = within(list).getAllByRole('listitem');
    expect(items).toHaveLength(2);
    expect(items[0]?.textContent).toContain('Пройдена');
    expect(items[1]?.textContent).toContain('Не пройдена');
    expect(items[1]?.textContent).toContain('страница слишком маленькая');
    expect(screen.getByText('Вторая проверка релиза', { exact: false })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Завершить проект' }).hasAttribute('disabled')).toBe(
      true,
    );
  });

  it('counts down to the second release check when the result says when it is possible', async () => {
    const retryAt = new Date(Date.now() + 5 * 3_600_000 + 30_000).toISOString();
    serve({
      latest: sampleCheck({
        results: [
          {
            key: 'release_alive_web',
            ok: false,
            blocking: true,
            message: 'x',
            data: resultData({ retryAt }),
          },
        ],
      }),
    });
    open();
    expect(
      await screen.findByText('Вторую проверку релиза можно будет сделать через 5 ч', { exact: false }),
    ).toBeTruthy();
  });

  it('announces a check that is still running and keeps the buttons off', async () => {
    serve({
      latest: sampleCheck({ status: 'running', finishedAt: null, validUntil: null, results: [] }),
    });
    open();
    expect(await screen.findByText('Проверка выполняется, результат появится здесь.')).toBeTruthy();
    expect(
      screen.getByRole('button', { name: 'Проверка выполняется…' }).hasAttribute('disabled'),
    ).toBe(true);
  });

  it('does not offer "Завершить проект" for an expired result and says so', async () => {
    serve({ latest: sampleCheck({ validUntil: new Date(Date.now() - 1000).toISOString() }) });
    open();
    expect(await screen.findByText('Результат устарел. Запусти проверки заново.')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Завершить проект' }).hasAttribute('disabled')).toBe(
      true,
    );
  });

  it('gives a member the link and the results, but no buttons to run or finish', async () => {
    serve({ meId: MEMBER_ID, latest: sampleCheck() });
    open();
    expect(await screen.findByLabelText('Ссылка на релиз')).toBeTruthy();
    expect(
      screen.getByText('Запускать проверки и завершать проект может только тимлид', {
        exact: false,
      }),
    ).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Запустить проверки' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Завершить проект' })).toBeNull();
  });
});

describe('FR-WORK-13: finishing the project', () => {
  it('finishes after a confirmation and shows the results', async () => {
    const control = serve({ latest: sampleCheck() });
    server.use(
      http.post(`${TEAM_URL}/completion`, () => {
        control.complete({ ...activeTeam(), status: 'completed' });
        return HttpResponse.json(sampleCompletion(), { status: 201 });
      }),
    );
    open();
    const finish = await screen.findByRole('button', { name: 'Завершить проект' });
    await waitFor(() => expect(finish.hasAttribute('disabled')).toBe(false));
    fireEvent.click(finish);
    fireEvent.click(screen.getByRole('button', { name: 'Да, завершить' }));
    expect(await screen.findByRole('heading', { level: 1, name: 'Проект завершён' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Завершить проект' })).toBeNull();
  });

  it('lists the unmet conditions on COMPLETION_BLOCKED', async () => {
    serve({ latest: sampleCheck() });
    server.use(
      http.post(`${TEAM_URL}/completion`, () =>
        problem(409, 'COMPLETION_BLOCKED', {
          unmet: [
            { code: 'STAGES_NOT_CLOSED', message: 'x' },
            { code: 'CONTRIBUTION_TOO_LOW', message: 'y' },
          ],
        }),
      ),
    );
    open();
    const finish = await screen.findByRole('button', { name: 'Завершить проект' });
    await waitFor(() => expect(finish.hasAttribute('disabled')).toBe(false));
    fireEvent.click(finish);
    fireEvent.click(screen.getByRole('button', { name: 'Да, завершить' }));
    const list = await screen.findByRole('list', { name: 'Невыполненные условия' });
    expect(within(list).getAllByRole('listitem')).toHaveLength(2);
    expect(list.textContent).toContain('Пройдены не все этапы.');
  });

  it('cancelling the confirmation sends nothing', async () => {
    serve({ latest: sampleCheck() });
    let sent = false;
    server.use(
      http.post(`${TEAM_URL}/completion`, () => {
        sent = true;
        return HttpResponse.json(sampleCompletion(), { status: 201 });
      }),
    );
    open();
    const finish = await screen.findByRole('button', { name: 'Завершить проект' });
    await waitFor(() => expect(finish.hasAttribute('disabled')).toBe(false));
    fireEvent.click(finish);
    fireEvent.click(screen.getByRole('button', { name: 'Отмена' }));
    expect(screen.getByRole('button', { name: 'Завершить проект' })).toBeTruthy();
    expect(sent).toBe(false);
  });
});

describe('FR-WORK-15: the results screen', () => {
  const completed = (): Team => ({
    ...activeTeam(),
    status: 'completed',
  });

  it('shows the overdue state, the composition and the contributions by role', async () => {
    serve({ team: completed() });
    server.use(http.get(`${TEAM_URL}/completion`, () => HttpResponse.json(sampleCompletion())));
    open();
    expect(await screen.findByRole('heading', { level: 1, name: 'Проект завершён' })).toBeTruthy();
    expect(screen.getByText('Без просрочки')).toBeTruthy();
    const composition = screen.getByRole('region', { name: 'Состав команды' });
    expect(composition.textContent).toContain('Анна Смирнова');
    expect(composition.textContent).toContain('Борис Иванов');
    const contributions = await screen.findByRole('region', { name: 'Вклад по ролям' });
    await waitFor(() => expect(contributions.textContent).toContain('Backend-разработчик'));
    expect(contributions.textContent).toContain('devops');
    expect(screen.getByText('Ждём', { exact: false })).toBeTruthy();
  });

  it('shows the days of delay', async () => {
    serve({ team: completed() });
    server.use(
      http.get(`${TEAM_URL}/completion`, () =>
        HttpResponse.json(sampleCompletion({ overdueDays: 4, onTime: false })),
      ),
    );
    open();
    expect(await screen.findByText('Просрочка 4 дн.')).toBeTruthy();
  });

  it('offers a retry when the results fail to load', async () => {
    serve({ team: completed() });
    server.use(http.get(`${TEAM_URL}/completion`, () => problem(400, 'VALIDATION_FAILED')));
    open();
    expect(await screen.findByRole('button', { name: 'Повторить' })).toBeTruthy();
  });
});

describe('loading and failures', () => {
  it('says the team is not available (404)', async () => {
    server.use(
      http.get(`${API}/v1/me`, () => HttpResponse.json({ id: LEAD_ID })),
      http.get(`${API}/v1/catalog/roles`, () =>
        HttpResponse.json({ items: ROLES, nextCursor: null }),
      ),
      http.get(TEAM_URL, () => problem(404, 'NOT_FOUND')),
    );
    open();
    expect((await screen.findByRole('alert')).textContent).toContain('не найдена');
  });
});
