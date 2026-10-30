// @vitest-environment jsdom
import { cleanup, fireEvent, screen } from '@testing-library/react';
import { HttpResponse, http } from 'msw';
import { setupServer } from 'msw/node';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { Member } from '@/features/teams/api';
import {
  LEAD_ID,
  MEMBER_ID,
  PRODUCT_TYPES,
  ROLE_LIST,
  TEAM_ID,
  sampleTeam,
} from '@/features/teams/fixtures';
import { TeamDetailPage } from '@/features/teams/TeamDetailPage';
import { problem } from '@/mocks/slice2/handlers';
import { API, renderWithClient } from '@/test/support';
import { isOnTrial } from './model';

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
  vi.useRealTimers();
});
afterAll(() => server.close());

const FUTURE = new Date(Date.now() + 5 * 86_400_000).toISOString();
const MEMBER_URL = `${API}/v1/teams/${TEAM_ID}/members/${MEMBER_ID}`;

function autoMember(overrides: Partial<Member> = {}): Member {
  return {
    userId: MEMBER_ID,
    displayName: 'Пётр Новиков',
    status: 'active',
    joinedVia: 'auto',
    joinedAt: '2026-01-02T10:00:00.000Z',
    trialUntil: FUTURE,
    roles: ['backend'],
    isLead: false,
    ...overrides,
  };
}

function serve(meId: string, member: Member = autoMember()) {
  const team = sampleTeam({ members: [...sampleTeam().members, member], memberCount: 2 });
  server.use(
    http.get(`${API}/v1/me`, () => HttpResponse.json({ id: meId })),
    http.get(`${API}/v1/catalog/roles`, () =>
      HttpResponse.json({ items: ROLE_LIST, nextCursor: null }),
    ),
    http.get(`${API}/v1/product-types`, () => HttpResponse.json({ items: PRODUCT_TYPES })),
    http.get(`${API}/v1/teams/${TEAM_ID}`, () => HttpResponse.json(team)),
    http.get(`${API}/v1/teams/${TEAM_ID}/events`, () =>
      HttpResponse.json({ items: [], nextCursor: null }),
    ),
  );
}
const open = () => renderWithClient(<TeamDetailPage teamId={TEAM_ID} />);

describe('isOnTrial', () => {
  it('is true only for an active auto-added member before trialUntil', () => {
    const now = Date.parse('2026-01-10T00:00:00.000Z');
    const base = autoMember({ trialUntil: '2026-01-12T00:00:00.000Z' });
    expect(isOnTrial(base, now)).toBe(true);
    expect(isOnTrial({ ...base, joinedVia: 'offer' }, now)).toBe(false);
    expect(isOnTrial({ ...base, trialUntil: '2026-01-09T00:00:00.000Z' }, now)).toBe(false);
    expect(isOnTrial({ ...base, trialUntil: null }, now)).toBe(false);
    expect(isOnTrial({ ...base, status: 'left' }, now)).toBe(false);
  });
});

describe('FR-TEAM-22: trial in the roster', () => {
  it('everyone sees the badge, only the lead sees the buttons', async () => {
    serve(MEMBER_ID);
    open();
    expect(await screen.findByText(/Пробный период до/)).toBeTruthy();
    expect(screen.queryByRole('button', { name: /Исключить участника/ })).toBeNull();
    expect(screen.queryByRole('button', { name: /Подтвердить участника/ })).toBeNull();
  });

  it('a member who was not auto-added has no badge and no buttons', async () => {
    serve(LEAD_ID, autoMember({ joinedVia: 'offer' }));
    open();
    await screen.findByText('Пётр Новиков');
    expect(screen.queryByText(/Пробный период до/)).toBeNull();
    expect(screen.queryByRole('button', { name: /Исключить участника/ })).toBeNull();
  });

  it('the lead confirms the trial', async () => {
    serve(LEAD_ID);
    let key: string | null = null;
    server.use(
      http.post(`${MEMBER_URL}/trial-confirmation`, ({ request }) => {
        key = request.headers.get('Idempotency-Key');
        return HttpResponse.json(autoMember({ trialUntil: null }));
      }),
    );
    open();
    fireEvent.click(await screen.findByRole('button', { name: 'Подтвердить участника Пётр Новиков' }));
    expect(await screen.findByText('Пробный период подтверждён.')).toBeTruthy();
    expect(key).toBeTruthy();
  });

  it('excluding asks for a confirmation first, then sends DELETE with a key', async () => {
    serve(LEAD_ID);
    let key: string | null = null;
    let deleted = false;
    server.use(
      http.delete(MEMBER_URL, ({ request }) => {
        deleted = true;
        key = request.headers.get('Idempotency-Key');
        return new HttpResponse(null, { status: 204 });
      }),
    );
    open();
    fireEvent.click(await screen.findByRole('button', { name: 'Исключить участника Пётр Новиков' }));
    expect(deleted).toBe(false);
    expect(screen.getByText('Исключить Пётр Новиков?')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Да, исключить' }));
    expect(await screen.findByText('Участник исключён.')).toBeTruthy();
    expect(deleted).toBe(true);
    expect(key).toBeTruthy();
  });

  it('the lead can back out of the exclusion', async () => {
    serve(LEAD_ID);
    open();
    fireEvent.click(await screen.findByRole('button', { name: 'Исключить участника Пётр Новиков' }));
    fireEvent.click(screen.getByRole('button', { name: 'Отмена' }));
    expect(screen.getByRole('button', { name: 'Исключить участника Пётр Новиков' })).toBeTruthy();
  });

  it.each([
    ['TRIAL_EXPIRED', 'Пробный период уже закончился'],
    ['NOT_AUTO_ADDED', 'Исключить можно только автоматически добавленного участника'],
  ])('409 %s is announced in Russian', async (code, text) => {
    serve(LEAD_ID);
    server.use(http.delete(MEMBER_URL, () => problem(409, code)));
    open();
    fireEvent.click(await screen.findByRole('button', { name: 'Исключить участника Пётр Новиков' }));
    fireEvent.click(screen.getByRole('button', { name: 'Да, исключить' }));
    expect((await screen.findByRole('alert')).textContent).toContain(text);
  });

  it('409 TRIAL_EXPIRED on confirm is announced too', async () => {
    serve(LEAD_ID);
    server.use(http.post(`${MEMBER_URL}/trial-confirmation`, () => problem(409, 'TRIAL_EXPIRED')));
    open();
    fireEvent.click(await screen.findByRole('button', { name: 'Подтвердить участника Пётр Новиков' }));
    expect((await screen.findByRole('alert')).textContent).toContain('Пробный период уже закончился');
  });
});
