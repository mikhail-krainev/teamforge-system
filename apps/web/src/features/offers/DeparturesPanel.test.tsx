// @vitest-environment jsdom
import { cleanup, fireEvent, screen, waitFor } from '@testing-library/react';
import { HttpResponse, http } from 'msw';
import { setupServer } from 'msw/node';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { ROLE_LIST, SEAT_ID, TEAM_ID, sampleSeat } from '@/features/teams/fixtures';
import { API, renderWithClient } from '@/test/support';
import { DeparturesPanel } from './DeparturesPanel';
import { DEPARTURE_ID, sampleDeparture } from './fixtures';

vi.mock('@/lib/api/client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/api/client')>();
  return { ...actual, apiClient: actual.createApiClient({ baseUrl: 'http://localhost/api' }) };
});

const server = setupServer();
beforeAll(() => server.listen({ onUnhandledFrame: 'error' }));
afterEach(() => {
  cleanup();
  server.resetHandlers();
});
afterAll(() => server.close());

const DEPARTURES = `${API}/v1/teams/${TEAM_ID}/departures`;
const roles = ROLE_LIST.map((r) => ({ ...r }));
const seats = [sampleSeat({ status: 'closed' })];
const show = (canDecide: boolean) =>
  renderWithClient(
    <DeparturesPanel teamId={TEAM_ID} seats={seats} roles={roles} canDecide={canDecide} />,
  );
const serve = (items: unknown[]) =>
  server.use(http.get(DEPARTURES, () => HttpResponse.json({ items, nextCursor: null })));

describe('FR-TEAM-12: DeparturesPanel', () => {
  it('shows an empty state', async () => {
    serve([]);
    show(true);
    expect(await screen.findByText('Решений по уходам сейчас ждать не нужно.')).toBeTruthy();
  });

  it('the lead continues without the member and closes the chosen seat', async () => {
    serve([sampleDeparture()]);
    let body: unknown;
    server.use(
      http.post(`${DEPARTURES}/${DEPARTURE_ID}/decision`, async ({ request }) => {
        body = await request.json();
        return HttpResponse.json(sampleDeparture({ decision: 'continue' }));
      }),
    );
    show(true);
    fireEvent.click(await screen.findByLabelText(/Закрыть место: Backend/));
    fireEvent.click(screen.getByRole('button', { name: 'Продолжить без участника' }));
    await waitFor(() => expect(body).toEqual({ decision: 'continue', closeSeatIds: [SEAT_ID] }));
  });

  it('the lead can ask for a replacement', async () => {
    serve([sampleDeparture()]);
    let body: unknown;
    server.use(
      http.post(`${DEPARTURES}/${DEPARTURE_ID}/decision`, async ({ request }) => {
        body = await request.json();
        return HttpResponse.json(sampleDeparture({ decision: 'replace' }));
      }),
    );
    show(true);
    fireEvent.click(await screen.findByRole('button', { name: 'Подобрать замену' }));
    await waitFor(() => expect(body).toEqual({ decision: 'replace' }));
  });

  it('a non-lead only reads', async () => {
    serve([sampleDeparture()]);
    show(false);
    expect(await screen.findByText('Решение принимает тимлид.')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Подобрать замену' })).toBeNull();
  });
});
