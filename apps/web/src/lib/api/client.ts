import createClient, { type Middleware } from 'openapi-fetch';
import type { paths } from 'shared';
import { NetworkError, toApiError } from './errors';
import { newIdempotencyKey } from './uuid';

const MUTATING = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);
export const IDEMPOTENCY_HEADER = 'Idempotency-Key';

/**
 * Safety net: every mutating request carries a key. Callers that need safe retries
 * pass their own key (see `useIdempotentMutation`), which is left untouched here.
 */
export const idempotencyMiddleware: Middleware = {
  onRequest({ request }) {
    if (MUTATING.has(request.method) && !request.headers.has(IDEMPOTENCY_HEADER)) {
      request.headers.set(IDEMPOTENCY_HEADER, newIdempotencyKey());
    }
    return request;
  },
};

/** Non-2xx becomes `ApiError` (problem+json parsed, `code` available); failed fetch becomes `NetworkError`. */
export const errorMiddleware: Middleware = {
  async onResponse({ response }) {
    if (!response.ok) throw await toApiError(response);
  },
  onError({ error }) {
    if (error instanceof DOMException && error.name === 'AbortError') return undefined;
    return new NetworkError({ cause: error });
  },
};

export interface ApiClientOptions {
  baseUrl?: string;
  fetch?: typeof fetch;
}

export function createApiClient(options: ApiClientOptions = {}) {
  const client = createClient<paths>({
    baseUrl: options.baseUrl ?? '/api',
    // Resolve fetch lazily so test doubles installed after client creation are honoured.
    fetch: options.fetch ?? ((request) => globalThis.fetch(request)),
  });
  client.use(idempotencyMiddleware, errorMiddleware);
  return client;
}

export type ApiClient = ReturnType<typeof createApiClient>;

/** Browser client: one origin, Next.js rewrites `/api/*` to the API container. */
export const apiClient: ApiClient = createApiClient();
