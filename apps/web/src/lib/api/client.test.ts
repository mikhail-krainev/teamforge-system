import { HttpResponse, http } from 'msw';
import { setupServer } from 'msw/node';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { createApiClient } from './client';
import { ApiError, NetworkError } from './errors';

const server = setupServer();
const client = createApiClient({ baseUrl: 'http://localhost/api' });

beforeAll(() => server.listen({ onUnhandledFrame: 'error' }));
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

describe('api client', () => {
  it('parses problem+json by code', async () => {
    server.use(
      http.get('http://localhost/api/health/ready', () =>
        HttpResponse.json(
          { title: 'Limit', status: 429, code: 'RATE_LIMITED', requestId: 'r1' },
          { status: 429, headers: { 'Content-Type': 'application/problem+json', 'Retry-After': '3' } },
        ),
      ),
    );
    const error = await client.GET('/health/ready').catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ApiError);
    expect(error).toMatchObject({ status: 429, code: 'RATE_LIMITED', retryAfterSeconds: 3 });
  });

  it('keeps a non-problem body (health 503)', async () => {
    server.use(
      http.get('http://localhost/api/health/ready', () =>
        HttpResponse.json({ status: 'down', checks: {} }, { status: 503 }),
      ),
    );
    const error = await client.GET('/health/ready').catch((e: unknown) => e);
    expect(error).toMatchObject({ status: 503, code: undefined, body: { status: 'down' } });
  });

  it('maps a failed fetch to NetworkError', async () => {
    server.use(http.get('http://localhost/api/health/ready', () => HttpResponse.error()));
    await expect(client.GET('/health/ready')).rejects.toBeInstanceOf(NetworkError);
  });

  it('adds Idempotency-Key to mutating requests only', async () => {
    const seen: Record<string, string | null> = {};
    server.use(
      http.post('http://localhost/api/auth/sign-out', ({ request }) => {
        seen.post = request.headers.get('Idempotency-Key');
        return HttpResponse.json({ success: true });
      }),
      http.get('http://localhost/api/health/ready', ({ request }) => {
        seen.get = request.headers.get('Idempotency-Key');
        return HttpResponse.json({ status: 'ok', checks: {} });
      }),
    );
    await client.POST('/auth/sign-out');
    await client.GET('/health/ready');
    expect(seen.post).toMatch(/^[0-9a-f-]{36}$/);
    expect(seen.get).toBeNull();
  });
});
