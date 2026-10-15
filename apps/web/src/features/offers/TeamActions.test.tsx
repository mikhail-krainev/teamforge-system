// @vitest-environment jsdom
import { cleanup, fireEvent, screen, waitFor } from '@testing-library/react';
import { QueryClientProvider } from '@tanstack/react-query';
import { HttpResponse, http } from 'msw';
import { setupServer } from 'msw/node';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { LEAD_ID, ROLE_LIST, SEAT_ID, TEAM_ID, sampleTeam } from '@/features/teams/fixtures';
import { problem } from '@/mocks/slice2/handlers';
import { API, renderWithClient } from '@/test/support';
import { sampleOffer } from './fixtures';
import { TeamActions } from './TeamActions';

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

const LEAVE = `${API}/v1/teams/${TEAM_ID}/members/me`;
const roles = ROLE_LIST.map((r) => ({ ...r }));
const open = (meId: string, isLead = false) =>
  renderWithClient(<TeamActions team={sampleTeam()} meId={meId} roles={roles} isLead={isLead} />);

describe('FR-TEAM-11: leaving the team', () => {
  it('asks for confirmation, then leaves', async () => {
    let calls = 0;
    server.use(
      http.delete(LEAVE, () => {
        calls += 1;
        return new HttpResponse(null, { status: 204 });
      }),
    );
    open(LEAD_ID, true);
    fireEvent.click(screen.getByRole('button', { name: 'Выйти из команды' }));
    expect(calls).toBe(0);
    fireEvent.click(screen.getByRole('button', { name: 'Да, выйти' }));
    expect(await screen.findByText(/Вы вышли из команды/)).toBeTruthy();
    expect(calls).toBe(1);
  });

  it('keeps the confirmation when the refreshed roster no longer lists the user', async () => {
    server.use(http.delete(LEAVE, () => new HttpResponse(null, { status: 204 })));
    const team = sampleTeam();
    const view = renderWithClient(
      <TeamActions team={team} meId={LEAD_ID} roles={roles} isLead={true} />,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Выйти из команды' }));
    fireEvent.click(screen.getByRole('button', { name: 'Да, выйти' }));
    expect(await screen.findByText(/Вы вышли из команды/)).toBeTruthy();
    // The realtime event refetches the team: the leaver is gone from the roster.
    const members = team.members.map((m) => (m.userId === LEAD_ID ? { ...m, status: 'left' } : m));
    view.rerender(
      <QueryClientProvider client={view.client}>
        <TeamActions
          team={{ ...team, members } as typeof team}
          meId={LEAD_ID}
          roles={roles}
          isLead={false}
        />
      </QueryClientProvider>,
    );
    expect(screen.getByText(/Вы вышли из команды/)).toBeTruthy();
  });

  it('cancel keeps the member in the team', () => {
    open(LEAD_ID, true);
    fireEvent.click(screen.getByRole('button', { name: 'Выйти из команды' }));
    fireEvent.click(screen.getByRole('button', { name: 'Отмена' }));
    expect(screen.getByRole('button', { name: 'Выйти из команды' })).toBeTruthy();
  });

  it('a failed leave is announced and the retry reuses the key', async () => {
    const keys: (string | null)[] = [];
    server.use(
      http.delete(LEAVE, ({ request }) => {
        keys.push(request.headers.get('Idempotency-Key'));
        return keys.length === 1
          ? problem(503, 'INTERNAL')
          : new HttpResponse(null, { status: 204 });
      }),
    );
    open(LEAD_ID, true);
    fireEvent.click(screen.getByRole('button', { name: 'Выйти из команды' }));
    fireEvent.click(screen.getByRole('button', { name: 'Да, выйти' }));
    await screen.findByRole('alert');
    fireEvent.click(screen.getByRole('button', { name: 'Да, выйти' }));
    await waitFor(() => expect(keys).toHaveLength(2));
    expect(keys[1]).toBe(keys[0]);
  });

  it('only the lead sees the offers and invitations links', () => {
    open(LEAD_ID);
    expect(screen.queryByRole('link', { name: 'Приглашения' })).toBeNull();
    expect(screen.getByRole('link', { name: 'Выходы участников' })).toBeTruthy();
  });

  it('the lead links to the offers and invitations pages', () => {
    open(LEAD_ID, true);
    expect(screen.getByRole('link', { name: 'Приглашения' }).getAttribute('href')).toBe(
      `/teams/${TEAM_ID}/invitations`,
    );
    expect(screen.getByRole('link', { name: 'Предложения и заявки' }).getAttribute('href')).toBe(
      `/teams/${TEAM_ID}/offers`,
    );
  });
});

describe('FR-TEAM-29: join request', () => {
  it('a non-member asks for an open seat', async () => {
    let body: unknown;
    server.use(
      http.post(`${API}/v1/teams/${TEAM_ID}/join-requests`, async ({ request }) => {
        body = await request.json();
        return HttpResponse.json(sampleOffer({ direction: 'user_to_lead' }), { status: 201 });
      }),
    );
    open('0192f0a0-7c1e-7b3a-8d2f-0000000000cc');
    expect(screen.queryByRole('button', { name: 'Выйти из команды' })).toBeNull();
    fireEvent.change(screen.getByLabelText('Место'), { target: { value: SEAT_ID } });
    fireEvent.click(screen.getByRole('button', { name: 'Отправить заявку' }));
    expect(await screen.findByText(/Заявка отправлена/)).toBeTruthy();
    expect(body).toEqual({ seatId: SEAT_ID });
  });

  it('requires a seat and shows GITHUB_REQUIRED with the linking link', async () => {
    server.use(
      http.post(`${API}/v1/teams/${TEAM_ID}/join-requests`, () => problem(409, 'GITHUB_REQUIRED')),
    );
    open('0192f0a0-7c1e-7b3a-8d2f-0000000000cc');
    fireEvent.click(screen.getByRole('button', { name: 'Отправить заявку' }));
    expect(await screen.findByText('Выберите место.')).toBeTruthy();
    fireEvent.change(screen.getByLabelText('Место'), { target: { value: SEAT_ID } });
    fireEvent.click(screen.getByRole('button', { name: 'Отправить заявку' }));
    expect(await screen.findByRole('link', { name: 'Привязать GitHub' })).toBeTruthy();
  });
});
