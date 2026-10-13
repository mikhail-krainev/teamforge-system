// @vitest-environment jsdom
import { QueryClientProvider } from '@tanstack/react-query';
import { cleanup, render, waitFor } from '@testing-library/react';
import { HttpResponse, http } from 'msw';
import { setupServer } from 'msw/node';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { makeQueryClient } from '@/app/providers';
import { TEAM_ID } from '@/features/teams/fixtures';
import { API } from '@/test/support';
import { RealtimeProvider, useTeamChannel } from './RealtimeProvider';

vi.mock('@/lib/api/client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/api/client')>();
  return { ...actual, apiClient: actual.createApiClient({ baseUrl: 'http://localhost/api' }) };
});

const USER = '0192f0a0-7c1e-7b3a-8d2f-3a4b5c6d7e8f';
const server = setupServer();
beforeAll(() => server.listen({ onUnhandledFrame: 'error' }));

class FakeWebSocket {
  static all: FakeWebSocket[] = [];
  readyState = 0;
  sent: unknown[] = [];
  closed = false;
  onopen: ((e: unknown) => void) | null = null;
  onmessage: ((e: { data: unknown }) => void) | null = null;
  onclose: ((e: { code: number }) => void) | null = null;
  onerror: ((e: unknown) => void) | null = null;
  constructor(readonly url: string) {
    FakeWebSocket.all.push(this);
  }
  send(data: string) {
    this.sent.push(JSON.parse(data));
  }
  close() {
    this.closed = true;
  }
}

afterEach(() => {
  cleanup();
  server.resetHandlers();
  FakeWebSocket.all = [];
  vi.unstubAllGlobals();
});
afterAll(() => server.close());

function Page() {
  useTeamChannel(TEAM_ID);
  return null;
}

describe('RealtimeProvider', () => {
  it('connects for a signed-in user, subscribes and invalidates by event type only', async () => {
    vi.stubGlobal('WebSocket', FakeWebSocket);
    server.use(http.get(`${API}/v1/me`, () => HttpResponse.json({ id: USER })));
    const client = makeQueryClient();
    client.setQueryData(['votes', TEAM_ID], ['stale']);
    client.setQueryData(['votes', 'other-team'], ['fresh']);
    render(
      <QueryClientProvider client={client}>
        <RealtimeProvider>
          <Page />
        </RealtimeProvider>
      </QueryClientProvider>,
    );
    await waitFor(() => expect(FakeWebSocket.all).toHaveLength(1));
    const socket = FakeWebSocket.all[0]!;
    expect(socket.url.endsWith('/api/ws')).toBe(true);
    socket.readyState = 1;
    socket.onopen?.({});
    expect(socket.sent).toEqual(
      expect.arrayContaining([
        { op: 'subscribe', channel: `user:${USER}` },
        { op: 'subscribe', channel: `team:${TEAM_ID}` },
      ]),
    );

    // The payload names another team: it is ignored, the channel decides what is refreshed.
    socket.onmessage?.({
      data: JSON.stringify({
        op: 'event',
        channel: `team:${TEAM_ID}`,
        type: 'vote.updated',
        data: { teamId: 'other-team' },
      }),
    });
    expect(client.getQueryState(['votes', TEAM_ID])?.isInvalidated).toBe(true);
    expect(client.getQueryState(['votes', 'other-team'])?.isInvalidated).toBe(false);
  });

  it('does not connect for a guest', async () => {
    vi.stubGlobal('WebSocket', FakeWebSocket);
    server.use(http.get(`${API}/v1/me`, () => new HttpResponse(null, { status: 401 })));
    const client = makeQueryClient();
    render(
      <QueryClientProvider client={client}>
        <RealtimeProvider>
          <Page />
        </RealtimeProvider>
      </QueryClientProvider>,
    );
    await waitFor(() => expect(client.getQueryState(['me'])?.status).toBe('success'));
    expect(FakeWebSocket.all).toHaveLength(0);
  });
});
