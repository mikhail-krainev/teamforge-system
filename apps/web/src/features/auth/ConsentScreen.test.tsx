// @vitest-environment jsdom
import { cleanup, fireEvent, screen, waitFor } from '@testing-library/react';
import { HttpResponse, http } from 'msw';
import { setupServer } from 'msw/node';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { CONSENT_HASH } from '@/mocks/slice2/db';
import { problem } from '@/mocks/slice2/handlers';
import { API, renderWithClient } from '@/test/support';
import { ConsentScreen } from './ConsentScreen';
import { ME_QUERY_KEY } from './session';

const replace = vi.fn();
vi.mock('next/navigation', () => ({ useRouter: () => ({ replace, refresh: vi.fn() }) }));
vi.mock('@/lib/api/client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/api/client')>();
  return { ...actual, apiClient: actual.createApiClient({ baseUrl: 'http://localhost/api' }) };
});

const TEXT = {
  version: '2026-10',
  textHash: CONSENT_HASH,
  text: 'Я согласен на обработку данных',
  publishedAt: '2026-10-01T00:00:00.000Z',
};
const server = setupServer();
beforeAll(() => server.listen({ onUnhandledFrame: 'error' }));
afterEach(() => {
  cleanup();
  server.resetHandlers();
  replace.mockClear();
});
afterAll(() => server.close());

const serveText = () =>
  server.use(http.get(`${API}/v1/consent/current`, () => HttpResponse.json(TEXT)));

describe('ConsentScreen', () => {
  it('shows the text and sends the accepted version and hash once', async () => {
    serveText();
    const bodies: unknown[] = [];
    server.use(
      http.post(`${API}/v1/me/consents`, async ({ request }) => {
        bodies.push(await request.json());
        return HttpResponse.json({}, { status: 201 });
      }),
    );
    const { client } = renderWithClient(<ConsentScreen />);
    client.setQueryData(ME_QUERY_KEY, { consentRequired: true });
    const accept = await screen.findByRole('button', { name: 'Принимаю' });
    await screen.findByText(TEXT.text);
    await waitFor(() => expect((accept as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(accept);
    fireEvent.click(accept);
    await waitFor(() => expect(bodies).toHaveLength(1));
    expect(bodies[0]).toEqual({ version: '2026-10', textHash: CONSENT_HASH });
    // The cached user is re-read so the gate lets the app through.
    await waitFor(() => expect(client.getQueryState(ME_QUERY_KEY)?.isInvalidated).toBe(true));
  });

  it('offers a retry when the text cannot be loaded and keeps accept disabled', async () => {
    server.use(http.get(`${API}/v1/consent/current`, () => problem(403, 'FORBIDDEN')));
    renderWithClient(<ConsentScreen />);
    expect(await screen.findByText('Не удалось загрузить текст согласия.')).toBeTruthy();
    expect((screen.getByRole('button', { name: 'Принимаю' }) as HTMLButtonElement).disabled).toBe(
      true,
    );
    server.use(http.get(`${API}/v1/consent/current`, () => HttpResponse.json(TEXT)));
    fireEvent.click(screen.getByRole('button', { name: 'Повторить' }));
    expect(await screen.findByText(TEXT.text)).toBeTruthy();
  });

  it('declining signs out and leaves for the sign-in page', async () => {
    serveText();
    let signOuts = 0;
    server.use(
      http.post(`${API}/auth/sign-out`, () => (signOuts++, HttpResponse.json({ success: true }))),
    );
    renderWithClient(<ConsentScreen />);
    fireEvent.click(await screen.findByRole('button', { name: 'Не принимаю, выйти' }));
    await waitFor(() => expect(replace).toHaveBeenCalledWith('/sign-in'));
    expect(signOuts).toBe(1);
  });
});
