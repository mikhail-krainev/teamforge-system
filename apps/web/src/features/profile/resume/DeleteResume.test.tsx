// @vitest-environment jsdom
import { QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { HttpResponse, http } from 'msw';
import { setupServer } from 'msw/node';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { makeQueryClient } from '@/app/providers';
import { problem } from '@/mocks/slice2/handlers';
import { API } from '@/test/support';
import { DeleteResume } from './DeleteResume';

vi.mock('@/lib/api/client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/api/client')>();
  return { ...actual, apiClient: actual.createApiClient({ baseUrl: 'http://localhost/api' }) };
});

const FIRST = '0192f0a0-7c1e-7b3a-8d2f-00000000a001';
const SECOND = '0192f0a0-7c1e-7b3a-8d2f-00000000a002';
const server = setupServer();
beforeAll(() => server.listen({ onUnhandledFrame: 'error' }));
afterEach(() => {
  cleanup();
  server.resetHandlers();
});
afterAll(() => server.close());

const open = () => fireEvent.click(screen.getByRole('button', { name: 'Удалить резюме' }));
const sure = () => fireEvent.click(screen.getByRole('button', { name: 'Да, удалить резюме' }));

function recordDeletes(respond: (uploadId: string) => Response) {
  const seen: Array<{ id: string; key: string | null }> = [];
  server.use(
    http.delete(`${API}/v1/me/resume/:uploadId`, ({ params, request }) => {
      const id = String(params.uploadId);
      seen.push({ id, key: request.headers.get('Idempotency-Key') });
      return respond(id);
    }),
  );
  return seen;
}

describe('DeleteResume', () => {
  it('asks first, then deletes and reports it', async () => {
    const seen = recordDeletes(() => new HttpResponse(null, { status: 204 }));
    const onDeleted = vi.fn();
    render(
      <QueryClientProvider client={makeQueryClient()}>
        <DeleteResume uploadId={FIRST} onDeleted={onDeleted} />
      </QueryClientProvider>,
    );
    open();
    expect(seen).toHaveLength(0);
    sure();
    await waitFor(() => expect(onDeleted).toHaveBeenCalledOnce());
    expect(seen[0]?.id).toBe(FIRST);
  });

  it('a repeated delete (404) counts as done', async () => {
    recordDeletes(() => problem(404, 'NOT_FOUND'));
    const onDeleted = vi.fn();
    render(
      <QueryClientProvider client={makeQueryClient()}>
        <DeleteResume uploadId={FIRST} onDeleted={onDeleted} />
      </QueryClientProvider>,
    );
    open();
    sure();
    await waitFor(() => expect(onDeleted).toHaveBeenCalledOnce());
  });

  it('S2CR-12: after an inconclusive failure the key is kept for the same upload and changes for another', async () => {
    let calls = 0;
    const seen = recordDeletes(() =>
      ++calls <= 2 ? problem(503, 'INTERNAL') : new HttpResponse(null, { status: 204 }),
    );
    const client = makeQueryClient();
    const view = render(
      <QueryClientProvider client={client}>
        <DeleteResume uploadId={FIRST} onDeleted={vi.fn()} />
      </QueryClientProvider>,
    );
    open();
    sure();
    await screen.findByRole('alert');
    sure();
    await waitFor(() => expect(calls).toBe(2));
    await screen.findByRole('alert');
    view.rerender(
      <QueryClientProvider client={client}>
        <DeleteResume uploadId={SECOND} onDeleted={vi.fn()} />
      </QueryClientProvider>,
    );
    sure();
    await waitFor(() => expect(seen).toHaveLength(3));
    expect(seen[1]?.key).toBe(seen[0]?.key);
    expect(seen[2]?.id).toBe(SECOND);
    expect(seen[2]?.key).not.toBe(seen[0]?.key);
  });
});
