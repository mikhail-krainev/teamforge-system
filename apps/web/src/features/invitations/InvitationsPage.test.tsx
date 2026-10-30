// @vitest-environment jsdom
import { cleanup, fireEvent, screen, waitFor } from '@testing-library/react';
import { HttpResponse, http } from 'msw';
import { setupServer } from 'msw/node';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  LEAD_ID,
  MEMBER_ID,
  ROLE_LIST,
  SEAT_ID,
  TEAM_ID,
  sampleTeam,
} from '@/features/teams/fixtures';
import { problem } from '@/mocks/slice2/handlers';
import { API, renderWithClient } from '@/test/support';
import { InvitationsPage } from './InvitationsPage';

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

const INVITATIONS = `${API}/v1/teams/${TEAM_ID}/invitations`;
const TOKEN = 'abcdefghij0123456789ABCDEFGHIJ-_abcdefghijK';
const INVITATION = {
  id: '0192f0a0-7c1e-7b3a-8d2f-00000000e101',
  seatId: SEAT_ID,
  roleCode: 'backend',
  inviteeHint: null,
  status: 'active',
  expiresAt: '2026-02-01T10:00:00.000Z',
  createdAt: '2026-01-01T10:00:00.000Z',
};

function serve(meId: string, items: unknown[] = []) {
  server.use(
    http.get(`${API}/v1/me`, () => HttpResponse.json({ id: meId })),
    http.get(`${API}/v1/catalog/roles`, () =>
      HttpResponse.json({ items: ROLE_LIST, nextCursor: null }),
    ),
    http.get(`${API}/v1/teams/${TEAM_ID}`, () => HttpResponse.json(sampleTeam())),
    http.get(INVITATIONS, () => HttpResponse.json({ items, nextCursor: null })),
  );
}
const open = () => renderWithClient(<InvitationsPage teamId={TEAM_ID} />);

describe('FR-TEAM-08: InvitationsPage', () => {
  it('creates an invitation and shows the link once with a copy button', async () => {
    serve(LEAD_ID);
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    let body: unknown;
    server.use(
      http.post(INVITATIONS, async ({ request }) => {
        body = await request.json();
        return HttpResponse.json({ invitation: INVITATION, token: TOKEN }, { status: 201 });
      }),
    );
    open();
    await screen.findByRole('option', { name: /Backend-разработчик/ });
    fireEvent.click(screen.getByRole('button', { name: 'Создать приглашение' }));
    const link = (await screen.findByRole('textbox', {
      name: 'Ссылка приглашения',
    })) as HTMLInputElement;
    expect(body).toEqual({ seatId: SEAT_ID });
    expect(link.value).toBe(`${window.location.origin}/invite#${TOKEN}`);
    expect(screen.getByText(/Ссылку показываем один раз/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Скопировать' }));
    await waitFor(() => expect(writeText).toHaveBeenCalledWith(link.value));
    expect(await screen.findByText('Скопировано в буфер обмена.')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Я сохранил ссылку' }));
    expect(screen.queryByRole('textbox', { name: 'Ссылка приглашения' })).toBeNull();
  });

  it('validates the optional GitHub login and email', async () => {
    serve(LEAD_ID);
    open();
    await screen.findByRole('option', { name: /Backend-разработчик/ });
    fireEvent.change(screen.getByLabelText(/GitHub-логин/), { target: { value: 'bad login!' } });
    fireEvent.change(screen.getByLabelText(/Электронная почта/), { target: { value: 'nope' } });
    fireEvent.click(screen.getByRole('button', { name: 'Создать приглашение' }));
    expect(await screen.findByText(/Логин GitHub: до 39/)).toBeTruthy();
    expect(screen.getByText(/Введи адрес почты/)).toBeTruthy();
  });

  it('shows INVITATION_LIMIT and keeps the button usable', async () => {
    serve(LEAD_ID);
    server.use(http.post(INVITATIONS, () => problem(409, 'INVITATION_LIMIT')));
    open();
    await screen.findByRole('option', { name: /Backend-разработчик/ });
    fireEvent.click(screen.getByRole('button', { name: 'Создать приглашение' }));
    expect((await screen.findByRole('alert')).textContent).toContain('Слишком много действующих');
    expect(
      (screen.getByRole('button', { name: 'Создать приглашение' }) as HTMLButtonElement).disabled,
    ).toBe(false);
  });

  it('lists invitations and revokes an active one', async () => {
    serve(LEAD_ID, [INVITATION, { ...INVITATION, id: 'x2', status: 'used' }]);
    let revoked = 0;
    server.use(
      http.delete(`${INVITATIONS}/${INVITATION.id}`, () => {
        revoked += 1;
        return new HttpResponse(null, { status: 204 });
      }),
    );
    open();
    const buttons = await screen.findAllByRole('button', { name: 'Отозвать' });
    expect(buttons).toHaveLength(1);
    fireEvent.click(buttons[0] as HTMLElement);
    expect(await screen.findByText('Приглашение отозвано.')).toBeTruthy();
    expect(revoked).toBe(1);
  });

  it('a non-lead cannot create invitations', async () => {
    serve(MEMBER_ID);
    open();
    expect((await screen.findByRole('alert')).textContent).toContain('только тимлиду');
    expect(screen.queryByRole('button', { name: 'Создать приглашение' })).toBeNull();
  });
});
