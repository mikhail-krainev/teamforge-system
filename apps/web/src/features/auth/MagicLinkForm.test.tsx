// @vitest-environment jsdom
import { cleanup, fireEvent, screen, waitFor } from '@testing-library/react';
import { HttpResponse, http } from 'msw';
import { setupServer } from 'msw/node';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { problem } from '@/mocks/slice2/handlers';
import { API, renderWithClient } from '@/test/support';
import { MagicLinkForm } from './MagicLinkForm';

vi.mock('@/lib/api/client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/api/client')>();
  return { ...actual, apiClient: actual.createApiClient({ baseUrl: 'http://localhost/api' }) };
});

const URL_ = `${API}/auth/sign-in/magic-link`;
const server = setupServer();
beforeAll(() => server.listen({ onUnhandledFrame: 'error' }));
afterEach(() => {
  cleanup();
  server.resetHandlers();
});
afterAll(() => server.close());

const type = (value: string) =>
  fireEvent.change(screen.getByLabelText(/Электронная почта/), { target: { value } });
const send = () =>
  fireEvent.click(screen.getByRole('button', { name: /Получить ссылку|Отправляем/ }));

describe('MagicLinkForm', () => {
  it('rejects a malformed address locally', () => {
    let calls = 0;
    server.use(http.post(URL_, () => (calls++, HttpResponse.json({ status: true }))));
    renderWithClient(<MagicLinkForm callbackPath="/profile" />);
    type('not-an-address');
    send();
    expect(screen.getByText(/Введите адрес электронной почты/)).toBeTruthy();
    expect(calls).toBe(0);
  });

  it('sends the trimmed address with the callback path and confirms without revealing anything', async () => {
    const bodies: unknown[] = [];
    server.use(
      http.post(URL_, async ({ request }) => {
        bodies.push(await request.json());
        return HttpResponse.json({ status: true });
      }),
    );
    renderWithClient(<MagicLinkForm callbackPath="/profile" />);
    type('  anna@example.com ');
    send();
    expect(await screen.findByText('Проверьте почту')).toBeTruthy();
    expect(bodies).toEqual([{ email: 'anna@example.com', callbackURL: '/profile' }]);
  });

  it('on 429 shows the Retry-After wait, locks the button and counts down', async () => {
    server.use(http.post(URL_, () => problem(429, 'RATE_LIMITED', {}, { 'Retry-After': '3' })));
    renderWithClient(<MagicLinkForm callbackPath="/profile" />);
    type('anna@example.com');
    send();
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain('3 секунды');
    const button = screen.getByRole('button', { name: 'Получить ссылку' }) as HTMLButtonElement;
    await waitFor(() => expect(button.disabled).toBe(true));
    expect(screen.getByText(/Повторить можно через/).textContent).toMatch(/[123] секунд/);
    // The wait ends by itself and the button comes back.
    await waitFor(() => expect(button.disabled).toBe(false), { timeout: 4500 });
  });

  it('a double click sends one request', async () => {
    let calls = 0;
    server.use(http.post(URL_, () => (calls++, HttpResponse.json({ status: true }))));
    renderWithClient(<MagicLinkForm callbackPath="/profile" />);
    type('anna@example.com');
    send();
    send();
    await screen.findByText('Проверьте почту');
    expect(calls).toBe(1);
  });
});
