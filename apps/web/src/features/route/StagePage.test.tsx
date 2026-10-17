// @vitest-environment jsdom
import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { HttpResponse, http } from 'msw';
import { setupServer } from 'msw/node';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { problem } from '@/mocks/slice2/handlers';
import { API, renderWithClient } from '@/test/support';
import type { ChecklistItem } from './api';
import {
  activeTeam,
  LEAD_ID,
  MEMBER_ID,
  samplePlaybook,
  sampleItem,
  sampleSpecItem,
  sampleStage,
  TEAM_ID,
} from './fixtures';
import { StagePage } from './StagePage';

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
const ITEM_URL = (id: string) => `${TEAM_URL}/checklist-items/${id}`;

interface Setup {
  meId?: string;
  items?: ChecklistItem[];
}

/** Serves a team with two stages and the given checklist of stage 1. */
function serve({ meId = LEAD_ID, items = [sampleItem(), sampleSpecItem()] }: Setup = {}) {
  server.use(
    http.get(`${API}/v1/me`, () => HttpResponse.json({ id: meId })),
    http.get(TEAM_URL, () => HttpResponse.json(activeTeam())),
    http.get(`${TEAM_URL}/stages`, () =>
      HttpResponse.json({
        items: [
          sampleStage(),
          sampleStage({
            ordinal: 2,
            key: 's2',
            title: 'Этап 2. Работа',
            status: 'pending',
            openedAt: null,
            dueAt: null,
          }),
        ],
        plannedEndAt: null,
      }),
    ),
    http.get(`${TEAM_URL}/stages/1/checklist`, () => HttpResponse.json({ items })),
    http.get(`${API}/v1/playbooks/:id`, () => HttpResponse.json(samplePlaybook())),
  );
}

const open = () => renderWithClient(<StagePage teamId={TEAM_ID} ordinal={1} />);
async function card(title: string): Promise<HTMLElement> {
  const heading = await screen.findByRole('heading', { level: 3, name: title });
  return heading.closest('li') as HTMLElement;
}

describe('FR-WORK-01, FR-WORK-02: the page of a stage', () => {
  it('shows the stage, its checklist, the executor and the review state', async () => {
    serve();
    open();
    expect(await screen.findByRole('heading', { level: 1, name: 'Этап 1. Старт' })).toBeTruthy();
    expect(screen.getByRole('list', { name: 'Чек-лист этапа' })).toBeTruthy();
    const spec = await card('Спецификация');
    expect(within(spec).getByText('Исполнитель: Борис Иванов')).toBeTruthy();
    expect(within(spec).getByRole('checkbox', { name: 'Выполнен' })).toBeTruthy();
    expect(screen.getByText('Срок до', { exact: false })).toBeTruthy();
  });

  it('shows the fallback step with its template for an item without a role holder', async () => {
    const charter = sampleSpecItem({
      title: 'Устав команды',
      fallbackUsed: true,
      assigneeUserId: null,
      fallback: {
        title: 'Устав по шаблону',
        instruction: 'Заполнить шаблон.',
        template: 'tpl_charter',
      },
    });
    serve({ items: [charter] });
    server.use(
      http.get(`${API}/v1/templates/tpl_charter`, () =>
        HttpResponse.json({
          key: 'tpl_charter',
          version: 1,
          title: 'Устав',
          bodyMd: '# Шаблон устава',
        }),
      ),
    );
    open();
    const view = within(await card('Устав команды'));
    expect(view.getByText('Запасной шаг: Устав по шаблону')).toBeTruthy();
    expect(view.getByText('Исполнитель: не назначен')).toBeTruthy();
    fireEvent.click(view.getByRole('button', { name: 'Открыть шаблон: Устав по шаблону' }));
    expect(await view.findByText('# Шаблон устава')).toBeTruthy();
  });
});

describe('FR-WORK-07: version conflicts', () => {
  it('shows the actual value on 409 and saves again over the actual version', async () => {
    serve({ items: [sampleItem({ version: 3 })] });
    const bodies: { version: number; outcome: string }[] = [];
    server.use(
      http.patch(ITEM_URL(sampleItem().id), async ({ request }) => {
        const body = (await request.json()) as { version: number; outcome: string };
        bodies.push(body);
        if (body.version === 3) {
          return problem(409, 'VERSION_CONFLICT', {
            current: sampleItem({ version: 4, outcome: 'Итоги Бориса: договорились о цели.' }),
          });
        }
        return HttpResponse.json(sampleItem({ version: 5, outcome: body.outcome }));
      }),
    );
    open();
    const view = within(await card('Kickoff команды'));
    fireEvent.change(view.getByLabelText('Итоги'), {
      target: { value: 'Итоги Кирилла: договорились о правилах.' },
    });
    fireEvent.click(view.getByRole('button', { name: 'Сохранить' }));

    const alert = await view.findByRole('alert');
    expect(alert.textContent).toContain('изменил этот пункт');
    expect(view.getByText('Итоги Бориса: договорились о цели.')).toBeTruthy();
    expect((view.getByLabelText('Итоги') as HTMLTextAreaElement).value).toBe(
      'Итоги Кирилла: договорились о правилах.',
    );

    fireEvent.click(view.getByRole('button', { name: 'Применить мои изменения заново' }));
    await waitFor(() => expect(view.queryByRole('alert')).toBeNull());
    expect(bodies.map((b) => b.version)).toEqual([3, 4]);
    expect(bodies[1]?.outcome).toBe('Итоги Кирилла: договорились о правилах.');
  });

  it('marks an item done at once and puts the box back when the server refuses', async () => {
    serve({ items: [sampleItem({ kind: 'artifact', submission: 'link' })] });
    server.use(http.patch(ITEM_URL(sampleItem().id), () => problem(422, 'RITUAL_FIELDS_REQUIRED')));
    open();
    const view = within(await card('Kickoff команды'));
    const box = view.getByRole('checkbox', { name: 'Выполнен' }) as HTMLInputElement;
    fireEvent.click(box);
    expect(box.checked).toBe(true);
    expect((await view.findByRole('alert')).textContent).toContain('заполните дату');
    await waitFor(() => expect(box.checked).toBe(false));
  });
});

describe('FR-WORK-04, SEC-05: links', () => {
  it('refuses a non-https link on the client without sending it', async () => {
    serve({ items: [sampleItem({ title: 'Доска', kind: 'artifact', submission: 'link' })] });
    open();
    const view = within(await card('Доска'));
    fireEvent.change(view.getByLabelText('Ссылка на артефакт'), {
      target: { value: 'http://127.0.0.1' },
    });
    fireEvent.click(view.getByRole('button', { name: 'Сохранить ссылку' }));
    expect((await view.findByRole('alert')).textContent).toContain('Ссылка отклонена');
  });

  it('shows LINK_REJECTED from the server as text and the check result in a live region', async () => {
    serve({
      items: [
        sampleItem({
          title: 'Доска',
          kind: 'artifact',
          submission: 'link',
          linkUrl: 'https://example.org/board',
          linkStatus: 'broken',
        }),
      ],
    });
    server.use(http.patch(ITEM_URL(sampleItem().id), () => problem(422, 'LINK_REJECTED')));
    open();
    const view = within(await card('Доска'));
    const status = view.getByRole('status', { name: 'Проверка ссылки' });
    expect(status.getAttribute('aria-live')).toBe('polite');
    expect(status.textContent).toContain('Ссылка не открылась');
    fireEvent.change(view.getByLabelText('Ссылка на артефакт'), {
      target: { value: 'https://169.254.169.254/latest/' },
    });
    fireEvent.click(view.getByRole('button', { name: 'Сохранить ссылку' }));
    expect((await view.findByRole('alert')).textContent).toContain('Ссылка отклонена');
  });
});

describe('FR-WORK-05: files', () => {
  it('refuses a file of a wrong type before uploading', async () => {
    serve({ items: [sampleSpecItem({ assigneeUserId: LEAD_ID })] });
    open();
    const view = within(await card('Спецификация'));
    const input = view.getByLabelText('Загрузить файл');
    const file = new File(['x'.repeat(2000)], 'run.exe', { type: 'application/octet-stream' });
    fireEvent.change(input, { target: { files: [file] } });
    expect((await view.findByRole('alert')).textContent).toContain('Этот тип файла не подходит');
  });

  it('lists an uploaded file with a signed download link', async () => {
    const file = {
      id: '0192f0a0-7c1e-7b3a-8d2f-00000000f001',
      originalName: 'spec.pdf',
      sizeBytes: 4096,
      mime: 'application/pdf',
      sha256: 'a'.repeat(64),
      uploadedBy: MEMBER_ID,
      createdAt: '2026-01-01T10:00:00.000Z',
    };
    serve({ items: [sampleSpecItem({ files: [file] })] });
    server.use(
      http.get(`${ITEM_URL(sampleSpecItem().id)}/files/${file.id}/download-url`, () =>
        HttpResponse.json({ url: 'https://files.example/spec', expiresAt: '2026-01-01T10:05:00Z' }),
      ),
    );
    open();
    const view = within(await card('Спецификация'));
    const link = await view.findByRole('link', { name: 'Скачать spec.pdf' });
    expect(link.getAttribute('href')).toBe('https://files.example/spec');
    expect(view.getByRole('button', { name: 'Удалить файл spec.pdf' })).toBeTruthy();
  });
});

describe('FR-WORK-09: review', () => {
  it('says the review has not started while no point is answered, and "not passed" only once someone answered', async () => {
    const unanswered = [
      { ordinal: 1, text: 'Записаны цели и не-цели?', answer: null },
      { ordinal: 2, text: 'Описаны альтернативы?', answer: null },
    ];
    serve({
      meId: LEAD_ID,
      items: [sampleSpecItem({ review: { passed: false, answers: unanswered } })],
    });
    open();
    const view = within(await card('Спецификация'));
    expect(await view.findByText('Ревью ещё не проводилось')).toBeTruthy();
    expect(view.queryByText('Ревью не пройдено')).toBeNull();
  });

  it('lets a reviewer answer every point and sends the answers with the item version', async () => {
    serve({ meId: LEAD_ID, items: [sampleSpecItem({ version: 7 })] });
    let sent: { version: number; answers: { ordinal: number; answer: boolean }[] } | undefined;
    server.use(
      http.put(`${ITEM_URL(sampleSpecItem().id)}/review`, async ({ request }) => {
        sent = (await request.json()) as typeof sent;
        return HttpResponse.json(
          sampleSpecItem({
            version: 8,
            review: {
              passed: false,
              answers: [
                { ordinal: 1, text: 'Записаны цели и не-цели?', answer: true },
                { ordinal: 2, text: 'Описаны альтернативы?', answer: false },
              ],
            },
          }),
        );
      }),
    );
    open();
    const view = within(await card('Спецификация'));
    fireEvent.click(view.getByRole('button', { name: 'Пройти ревью' }));
    const form = within(screen.getByRole('group', { name: 'Чек-лист ревью' }));
    const submit = form.getByRole('button', { name: 'Отправить ревью' }) as HTMLButtonElement;
    expect(submit.disabled).toBe(true);
    const point = (text: string) => within(form.getByRole('group', { name: text }));
    fireEvent.click(point('Записаны цели и не-цели?').getByRole('radio', { name: 'Да' }));
    fireEvent.click(point('Описаны альтернативы?').getByRole('radio', { name: 'Нет' }));
    fireEvent.click(submit);
    expect(await view.findByText('Ревью не пройдено')).toBeTruthy();
    expect(sent).toEqual({
      version: 7,
      answers: [
        { ordinal: 1, answer: true },
        { ordinal: 2, answer: false },
      ],
    });
  });

  it('does not offer the review to the executor of the item', async () => {
    serve({ meId: MEMBER_ID, items: [sampleSpecItem()] });
    open();
    const view = within(await card('Спецификация'));
    expect(view.queryByRole('button', { name: 'Пройти ревью' })).toBeNull();
    expect(view.getByText('Свой пункт проверять нельзя', { exact: false })).toBeTruthy();
  });
});

describe('FR-WORK-10: transition', () => {
  it('lists the unmet conditions on the first click, then the server list on 409', async () => {
    serve({ items: [sampleItem()] });
    server.use(
      http.post(`${TEAM_URL}/stage-transitions`, () =>
        problem(409, 'STAGE_TRANSITION_BLOCKED', {
          unmet: [{ code: 'AUTO_CHECKS_FAILED', message: 'Проверки не пройдены' }],
        }),
      ),
    );
    open();
    fireEvent.click(await screen.findByRole('button', { name: 'Перейти к следующему этапу' }));
    const hint = within(screen.getByRole('list', { name: 'Невыполненные условия' }));
    expect(hint.getByText(/обязательные пункты/)).toBeTruthy();
    expect(hint.getByText(/меньше 24 часов/)).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'Да, перейти' }));
    const list = await screen.findByText('Не прошли автоматические проверки пунктов.');
    expect(list).toBeTruthy();
    expect(screen.queryByText(/меньше 24 часов/)).toBeNull();
  });

  it('opens the next stage on success', async () => {
    serve({ items: [sampleItem({ status: 'done' })] });
    server.use(
      http.post(`${TEAM_URL}/stage-transitions`, () =>
        HttpResponse.json({ closedOrdinal: 1, openedOrdinal: 2 }, { status: 201 }),
      ),
    );
    open();
    fireEvent.click(await screen.findByRole('button', { name: 'Перейти к следующему этапу' }));
    fireEvent.click(screen.getByRole('button', { name: 'Да, перейти' }));
    expect(await screen.findByText('Открыт этап 2.')).toBeTruthy();
  });

  it('tells the lead that another participant already moved the project (STAGE_NOT_OPEN)', async () => {
    serve({ items: [sampleItem({ status: 'done' })] });
    server.use(http.post(`${TEAM_URL}/stage-transitions`, () => problem(409, 'STAGE_NOT_OPEN')));
    open();
    fireEvent.click(await screen.findByRole('button', { name: 'Перейти к следующему этапу' }));
    fireEvent.click(screen.getByRole('button', { name: 'Да, перейти' }));
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain('другой участник уже перевёл проект дальше');
  });

  it('shows no transition button to a member who is not the lead', async () => {
    serve({ meId: MEMBER_ID, items: [sampleItem()] });
    open();
    await card('Kickoff команды');
    expect(screen.queryByRole('button', { name: 'Перейти к следующему этапу' })).toBeNull();
    expect(screen.getByText('Перейти к следующему этапу может только тимлид.')).toBeTruthy();
  });

  it('confirms the participation of a member', async () => {
    serve({ items: [sampleItem()] });
    server.use(
      http.post(`${TEAM_URL}/participation-confirmations`, () =>
        HttpResponse.json(
          { userId: MEMBER_ID, stageOrdinal: 1, confirmedBy: LEAD_ID, at: '2026-01-01T10:00:00Z' },
          { status: 201 },
        ),
      ),
    );
    open();
    fireEvent.click(
      await screen.findByRole('button', { name: 'Подтвердить участие: Борис Иванов' }),
    );
    expect(await screen.findByText('Участие подтверждено: Борис Иванов')).toBeTruthy();
  });
});
