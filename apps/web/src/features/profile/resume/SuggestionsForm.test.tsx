// @vitest-environment jsdom
import { cleanup, fireEvent, screen, waitFor } from '@testing-library/react';
import { HttpResponse, http } from 'msw';
import { setupServer } from 'msw/node';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { ROLES, sampleProfile } from '@/mocks/slice2/db';
import { problem } from '@/mocks/slice2/handlers';
import { API, renderWithClient, sampleUpload, UPLOAD_ID } from '@/test/support';
import { SuggestionsForm } from './SuggestionsForm';

vi.mock('@/lib/api/client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/api/client')>();
  return { ...actual, apiClient: actual.createApiClient({ baseUrl: 'http://localhost/api' }) };
});

const CONFIRM = `${API}/v1/me/resume/${UPLOAD_ID}/confirmations`;
const server = setupServer();
beforeAll(() => server.listen({ onUnhandledFrame: 'error' }));
afterEach(() => {
  cleanup();
  server.resetHandlers();
});
afterAll(() => server.close());

const ALL_FIELDS = {
  displayName: 'Мария',
  timezone: 'Europe/Moscow',
  hoursPerWeek: 15,
  stack: ['react'],
  rolePrefs: [{ roleCode: 'frontend', level: 'junior' as const }],
  experience: [{ title: 'Стажировка', from: '2025-01-01', to: null }],
  strengths: ['Внимательность'],
  weaknesses: ['Дедлайны'],
};

interface Seen {
  key: string | null;
  body: {
    confirmedFields: Record<string, unknown>;
    keepFile: boolean;
    profileVersion: number | null;
  };
}

function recordConfirmations(respond: () => Response) {
  const seen: Seen[] = [];
  server.use(
    http.get(`${API}/v1/catalog/roles`, () =>
      HttpResponse.json({ items: ROLES, nextCursor: null }),
    ),
    http.post(CONFIRM, async ({ request }) => {
      seen.push({
        key: request.headers.get('Idempotency-Key'),
        body: (await request.json()) as Seen['body'],
      });
      return respond();
    }),
  );
  return seen;
}

function renderForm(props: {
  profileVersion: number | null;
  suggestions?: Record<string, unknown>;
  onConfirmed?: () => void;
  onConflict?: () => void;
}) {
  const upload = sampleUpload({
    extractedText: 'Текст резюме <b>не html</b>',
    suggestions: (props.suggestions ?? { displayName: 'Мария', stack: ['react'] }) as never,
  });
  return renderWithClient(
    <SuggestionsForm
      upload={upload}
      profileVersion={props.profileVersion}
      onConfirmed={props.onConfirmed ?? vi.fn()}
      onConflict={props.onConflict ?? vi.fn()}
    />,
  );
}

const tick = (label: string) => fireEvent.click(screen.getByLabelText(new RegExp(`^${label}`)));
const confirm = () =>
  fireEvent.click(screen.getByRole('button', { name: 'Подтвердить выбранные поля' }));

describe('SuggestionsForm', () => {
  it('renders the resume text as escaped text and sends only the ticked fields', async () => {
    const seen = recordConfirmations(() => HttpResponse.json(sampleProfile({ version: 2 })));
    const onConfirmed = vi.fn();
    renderForm({ profileVersion: 1, onConfirmed });
    expect(screen.getByText('Текст резюме <b>не html</b>')).toBeTruthy();
    tick('Имя');
    confirm();
    await waitFor(() => expect(onConfirmed).toHaveBeenCalled());
    expect(seen[0]?.body).toEqual({
      confirmedFields: { displayName: 'Мария' },
      keepFile: false,
      profileVersion: 1,
    });
  });

  it('asks to tick at least one field and sends nothing', () => {
    const seen = recordConfirmations(() => HttpResponse.json(sampleProfile()));
    renderForm({ profileVersion: 1 });
    confirm();
    expect(screen.getByRole('alert').textContent).toContain('Отметьте хотя бы одно поле');
    expect(seen).toHaveLength(0);
  });

  it('S2CR-10: without a profile, a partial choice is explained before any request', () => {
    const seen = recordConfirmations(() => HttpResponse.json(sampleProfile()));
    renderForm({ profileVersion: null });
    tick('Имя');
    confirm();
    const text = screen.getByRole('alert').textContent ?? '';
    expect(text).toContain('Профиля ещё нет');
    expect(text).toContain('Часовой пояс');
    expect(seen).toHaveLength(0);
  });

  it('S2CR-10: without a profile, all required fields go through', async () => {
    const seen = recordConfirmations(() => HttpResponse.json(sampleProfile({ version: 1 })));
    const onConfirmed = vi.fn();
    renderForm({ profileVersion: null, suggestions: ALL_FIELDS, onConfirmed });
    for (const label of [
      'Имя',
      'Часовой пояс',
      'Часов в',
      'Стек',
      'Роли',
      'Опыт',
      'Сильные',
      'Слабые',
    ]) {
      tick(label);
    }
    confirm();
    await waitFor(() => expect(onConfirmed).toHaveBeenCalled());
    expect(Object.keys(seen[0]?.body.confirmedFields ?? {}).sort()).toEqual(
      Object.keys(ALL_FIELDS).sort(),
    );
  });

  it('S2CR-10: a 422 required_for_new_profile names the missing fields', async () => {
    recordConfirmations(() =>
      problem(422, 'VALIDATION_FAILED', {
        errors: [
          { pointer: '/confirmedFields/timezone', code: 'required_for_new_profile', message: 'x' },
          { pointer: '/confirmedFields/stack', code: 'required_for_new_profile', message: 'x' },
        ],
      }),
    );
    // The profile was removed elsewhere: the form still believed there was one and got a 422.
    renderForm({ profileVersion: 3 });
    tick('Имя');
    confirm();
    const alert = await screen.findByText(/Профиля ещё нет/);
    expect(alert.textContent).toContain('Часовой пояс');
    expect(alert.textContent).toContain('Стек');
    expect(alert.textContent).not.toContain('Проверьте введённые данные');
  });

  it('S2CR-12: keepFile is part of the idempotency key: same input reuses it, a changed choice does not', async () => {
    let calls = 0;
    const seen = recordConfirmations(() =>
      ++calls <= 2 ? problem(500, 'INTERNAL') : HttpResponse.json(sampleProfile({ version: 2 })),
    );
    renderForm({ profileVersion: 1 });
    tick('Имя');
    confirm();
    await screen.findByText(/Внутренняя ошибка/);
    confirm(); // the same input after an inconclusive 500: the same key
    await waitFor(() => expect(seen).toHaveLength(2));
    await waitFor(() => expect(calls).toBe(2));
    fireEvent.click(screen.getByLabelText(/Хранить файл/));
    confirm(); // another keepFile is another request: another key
    await waitFor(() => expect(seen).toHaveLength(3));
    expect(seen[1]?.key).toBe(seen[0]?.key);
    expect(seen[2]?.key).not.toBe(seen[0]?.key);
    expect(seen[2]?.body.keepFile).toBe(true);
  });

  it('on 409 shows the notice and hands the fresh profile over', async () => {
    recordConfirmations(() => problem(409, 'VERSION_CONFLICT'));
    server.use(
      http.get(`${API}/v1/me/profile`, () => HttpResponse.json(sampleProfile({ version: 7 }))),
    );
    const onConflict = vi.fn();
    renderForm({ profileVersion: 1, onConflict });
    tick('Имя');
    confirm();
    await waitFor(() =>
      expect(onConflict).toHaveBeenCalledWith(expect.objectContaining({ version: 7 })),
    );
    expect(screen.getByText(/Профиль изменился/)).toBeTruthy();
  });
});
