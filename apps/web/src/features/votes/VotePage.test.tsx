// @vitest-environment jsdom
import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { HttpResponse, http } from 'msw';
import { setupServer } from 'msw/node';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { TEAM_ID } from '@/features/teams/fixtures';
import { problem } from '@/mocks/slice2/handlers';
import { API, renderWithClient } from '@/test/support';
import type { LeaderVote } from './api';
import { ANNA_ID, BOB_ID, CAROL_ID, VOTE_ID, sampleVote, voteTeam } from './fixtures';
import { VotePage } from './VotePage';

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

const VOTES = `${API}/v1/teams/${TEAM_ID}/leader-votes`;
const VOTE_URL = `${VOTES}/${VOTE_ID}`;

/** Serves the vote the test holds in `state.vote`; actions replace it like the server would. */
function serve(initial: LeaderVote | null, meId = ANNA_ID) {
  const state = { vote: initial };
  server.use(
    http.get(`${API}/v1/me`, () => HttpResponse.json({ id: meId })),
    http.get(`${API}/v1/teams/${TEAM_ID}`, () => HttpResponse.json(voteTeam())),
    http.get(VOTES, () =>
      HttpResponse.json({ items: state.vote ? [state.vote] : [], nextCursor: null }),
    ),
  );
  return state;
}

const open = () => renderWithClient(<VotePage teamId={TEAM_ID} />);
const phase = () => screen.findByRole('status', { name: 'Этап голосования' });

describe('FR-TEAM-14: vote phases', () => {
  it('announces the phase in a polite live region and shows the countdown', async () => {
    serve(sampleVote());
    open();
    expect(
      await screen.findByRole('heading', { level: 1, name: 'Голосование за тимлида' }),
    ).toBeTruthy();
    const region = await phase();
    expect(region.getAttribute('aria-live')).toBe('polite');
    expect(region.textContent).toContain('Выдвижение кандидатов');
    expect(
      screen.getByText(/5 ч 29 мин до окончания этапа|5 ч 30 мин до окончания этапа/),
    ).toBeTruthy();
  });

  it.each([
    ['voting', 'Голосование идёт'],
    ['runoff', 'Второй тур'],
    ['confirming', 'Подтверждение победителя'],
    ['offering', 'Предложение роли тимлида'],
    ['closed', 'Голосование завершено'],
  ] as const)('phase %s reads "%s"', async (status, text) => {
    serve(sampleVote({ status }));
    open();
    expect((await phase()).textContent).toContain(text);
  });

  it('a phase change replaces the text inside the same live region', async () => {
    const state = serve(sampleVote());
    const { client } = open();
    const region = await phase();
    state.vote = sampleVote({ status: 'voting' });
    await client.invalidateQueries({ queryKey: ['votes', TEAM_ID] });
    await waitFor(() => expect(region.textContent).toContain('Голосование идёт'));
    expect(await phase()).toBe(region);
  });

  it('with no vote it offers to request one and shows the counter', async () => {
    serve(null);
    server.use(
      http.get(`${API}/v1/teams/${TEAM_ID}/leader-vote-requests`, () =>
        HttpResponse.json({ requests: 1, required: 2, voteId: null }),
      ),
      http.post(`${API}/v1/teams/${TEAM_ID}/leader-vote-requests`, () =>
        HttpResponse.json({ requests: 2, required: 2, voteId: null }, { status: 201 }),
      ),
    );
    open();
    expect(await screen.findByText(/Нужно запросов: 2, сейчас: 1/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Запросить голосование' }));
    expect(await screen.findByText('Ваш запрос учтён.')).toBeTruthy();
  });

  it('a non-member sees the explanation instead of the vote', async () => {
    server.use(
      http.get(`${API}/v1/me`, () => HttpResponse.json({ id: ANNA_ID })),
      http.get(`${API}/v1/teams/${TEAM_ID}`, () => problem(404, 'NOT_FOUND')),
      http.get(VOTES, () => problem(404, 'NOT_FOUND')),
    );
    open();
    expect(await screen.findByText('Голосование видят только участники команды.')).toBeTruthy();
  });
});

describe('FR-TEAM-14: nomination', () => {
  it('nominates oneself, with an idempotency key', async () => {
    serve(sampleVote());
    let body: unknown;
    let key: string | null = null;
    server.use(
      http.post(`${VOTE_URL}/candidates`, async ({ request }) => {
        body = await request.json();
        key = request.headers.get('Idempotency-Key');
        return HttpResponse.json(sampleVote(), { status: 201 });
      }),
    );
    open();
    fireEvent.click(await screen.findByRole('button', { name: 'Выдвинуть себя' }));
    await waitFor(() => expect(body).toEqual({ userId: ANNA_ID }));
    expect(key).toBeTruthy();
  });

  it('nominates another member', async () => {
    serve(sampleVote());
    let body: unknown;
    server.use(
      http.post(`${VOTE_URL}/candidates`, async ({ request }) => {
        body = await request.json();
        return HttpResponse.json(sampleVote(), { status: 201 });
      }),
    );
    open();
    fireEvent.click(await screen.findByRole('button', { name: 'Выдвинуть: Борис Иванов' }));
    await waitFor(() => expect(body).toEqual({ userId: BOB_ID }));
  });

  it('a candidate nominated by someone else consents, then can withdraw', async () => {
    const state = serve(
      sampleVote({ candidates: [{ userId: ANNA_ID, confirmed: false, withdrawn: false }] }),
    );
    let consented = false;
    server.use(
      http.post(`${VOTE_URL}/candidates/${ANNA_ID}/consent`, () => {
        consented = true;
        state.vote = sampleVote({
          candidates: [{ userId: ANNA_ID, confirmed: true, withdrawn: false }],
        });
        return HttpResponse.json(state.vote);
      }),
      http.post(`${VOTE_URL}/candidates/me/withdrawal`, () => {
        state.vote = sampleVote({
          candidates: [{ userId: ANNA_ID, confirmed: true, withdrawn: true }],
        });
        return HttpResponse.json(state.vote);
      }),
    );
    open();
    expect(await screen.findByText('ждём согласия')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Согласен баллотироваться' }));
    await waitFor(() => expect(consented).toBe(true));
    expect(await screen.findByText('согласие получено')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Согласен баллотироваться' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Снять кандидатуру' }));
    expect(await screen.findByText('снял кандидатуру')).toBeTruthy();
  });

  it('VOTE_PHASE explains that the phase moved on and the page is refreshed', async () => {
    const state = serve(sampleVote());
    server.use(
      http.post(`${VOTE_URL}/candidates`, () => {
        state.vote = sampleVote({ status: 'voting' });
        return problem(409, 'VOTE_PHASE');
      }),
    );
    open();
    fireEvent.click(await screen.findByRole('button', { name: 'Выдвинуть себя' }));
    expect(await screen.findByRole('alert')).toBeTruthy();
    expect(screen.getByRole('alert').textContent).toContain('Этап уже сменился');
    await waitFor(async () => expect((await phase()).textContent).toContain('Голосование идёт'));
  });
});

const twoCandidates: Partial<LeaderVote> = {
  status: 'voting',
  candidates: [
    { userId: BOB_ID, confirmed: true, withdrawn: false, votes: null },
    { userId: CAROL_ID, confirmed: true, withdrawn: false, votes: null },
  ],
};

describe('FR-TEAM-16 / FR-TEAM-21: ballot', () => {
  it('casts one ballot, then only confirms it - no names, no counts', async () => {
    const state = serve(sampleVote(twoCandidates));
    let body: unknown;
    server.use(
      http.post(`${VOTE_URL}/ballots`, async ({ request }) => {
        body = await request.json();
        state.vote = sampleVote({ ...twoCandidates, myBallotCast: true, ballotsCast: 1 });
        return HttpResponse.json(state.vote, { status: 201 });
      }),
    );
    open();
    expect(await screen.findByText('Проголосовали: 0 из 3 (кворум: 2)')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Голосовать за Борис Иванов' }));
    await waitFor(() => expect(body).toEqual({ candidateUserId: BOB_ID }));
    expect(await screen.findByText(/Ваш голос учтён/)).toBeTruthy();
    expect(screen.queryByRole('button', { name: /Голосовать за/ })).toBeNull();
    expect(screen.queryByText(/Голосов: /)).toBeNull();
  });

  it('ALREADY_VOTED is announced', async () => {
    serve(sampleVote(twoCandidates));
    server.use(http.post(`${VOTE_URL}/ballots`, () => problem(409, 'ALREADY_VOTED')));
    open();
    fireEvent.click(await screen.findByRole('button', { name: 'Голосовать за Вера Орлова' }));
    expect((await screen.findByRole('alert')).textContent).toContain('Вы уже проголосовали');
  });

  it('a member who cannot vote gets no ballot buttons', async () => {
    serve(sampleVote({ ...twoCandidates, canVote: false }));
    open();
    expect(await screen.findByText('Вы не можете голосовать в этом этапе.')).toBeTruthy();
    expect(screen.queryByRole('button', { name: /Голосовать за/ })).toBeNull();
  });

  it('shows vote counts only after the vote is closed', async () => {
    serve(
      sampleVote({
        status: 'closed',
        outcome: 'elected',
        winnerUserId: BOB_ID,
        canVote: false,
        phaseDeadline: null,
        candidates: [
          { userId: BOB_ID, confirmed: true, withdrawn: false, votes: 2 },
          { userId: CAROL_ID, confirmed: true, withdrawn: false, votes: 1 },
        ],
      }),
    );
    open();
    expect(await screen.findByText(/Голосов: 2/)).toBeTruthy();
    expect(screen.getByText(/Голосов: 1/)).toBeTruthy();
    expect(screen.getByText('Тимлид: Борис Иванов')).toBeTruthy();
    expect(screen.getByText('Тимлид избран голосованием.')).toBeTruthy();
    expect(screen.queryByText(/до окончания этапа/)).toBeNull();
  });

  it('ignores counts that leak before the close', async () => {
    serve(
      sampleVote({
        status: 'voting',
        candidates: [{ userId: BOB_ID, confirmed: true, withdrawn: false, votes: 5 }],
      }),
    );
    open();
    await screen.findByText('Борис Иванов');
    expect(screen.queryByText(/Голосов: /)).toBeNull();
  });
});

describe('FR-TEAM-17: confirmation and offer', () => {
  it('the winner accepts the lead role', async () => {
    serve(
      sampleVote({
        status: 'confirming',
        candidates: [{ userId: ANNA_ID, confirmed: true, withdrawn: false }],
        pendingOffer: {
          userId: ANNA_ID,
          kind: 'winner_confirmation',
          expiresAt: '2026-03-01T10:00:00.000Z',
        },
      }),
    );
    let body: unknown;
    server.use(
      http.post(`${VOTE_URL}/offer-responses`, async ({ request }) => {
        body = await request.json();
        return HttpResponse.json(sampleVote({ status: 'closed', outcome: 'elected' }));
      }),
    );
    open();
    expect((await phase()).textContent).toContain('Подтверждение победителя');
    fireEvent.click(await screen.findByRole('button', { name: 'Принять роль тимлида' }));
    await waitFor(() => expect(body).toEqual({ accept: true }));
  });

  it('declining sends accept=false', async () => {
    serve(
      sampleVote({
        status: 'offering',
        pendingOffer: {
          userId: ANNA_ID,
          kind: 'senior_offer',
          expiresAt: '2026-03-01T10:00:00.000Z',
        },
      }),
    );
    let body: unknown;
    server.use(
      http.post(`${VOTE_URL}/offer-responses`, async ({ request }) => {
        body = await request.json();
        return HttpResponse.json(sampleVote({ status: 'offering' }));
      }),
    );
    open();
    fireEvent.click(await screen.findByRole('button', { name: 'Отказаться от роли' }));
    await waitFor(() => expect(body).toEqual({ accept: false }));
  });

  it('other members only wait for the answer', async () => {
    serve(
      sampleVote({
        status: 'confirming',
        pendingOffer: {
          userId: BOB_ID,
          kind: 'winner_confirmation',
          expiresAt: '2026-03-01T10:00:00.000Z',
        },
      }),
    );
    open();
    const actions = await screen.findByRole('region', { name: 'Ваши действия' });
    expect(within(actions).queryByRole('button')).toBeNull();
    expect(within(actions).getByText(/Ждём ответа до/)).toBeTruthy();
  });
});
