import { randomUUID } from 'node:crypto';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import type { InjectResponse } from './http.js';

export interface TestUser {
  id: string;
}

export interface RequestOptions {
  /**
   * Idempotency-Key: a random one by default (a new key per call), an explicit string to repeat a
   * request, `null` to omit the header.
   */
  idempotencyKey?: string | null;
  headers?: Record<string, string>;
}

type Method = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';

/** A caller with a fixed identity. All paths are relative to `/api`, for example `/v1/teams`. */
export class ApiClient {
  constructor(
    private readonly app: NestFastifyApplication,
    private readonly userId: string | undefined,
  ) {}

  request(
    method: Method,
    url: string,
    body?: unknown,
    options: RequestOptions = {},
  ): Promise<InjectResponse> {
    const headers: Record<string, string> = { ...options.headers };
    if (this.userId !== undefined) headers['x-test-user'] = this.userId;
    if (method !== 'GET' && options.idempotencyKey !== null) {
      headers['idempotency-key'] = options.idempotencyKey ?? randomUUID();
    }
    return this.app.inject({
      method,
      url: `/api${url}`,
      headers,
      ...(body === undefined ? {} : { payload: body as Record<string, unknown> }),
    });
  }

  get(url: string, options?: RequestOptions): Promise<InjectResponse> {
    return this.request('GET', url, undefined, options);
  }

  post(url: string, body?: unknown, options?: RequestOptions): Promise<InjectResponse> {
    return this.request('POST', url, body, options);
  }

  put(url: string, body?: unknown, options?: RequestOptions): Promise<InjectResponse> {
    return this.request('PUT', url, body, options);
  }

  patch(url: string, body?: unknown, options?: RequestOptions): Promise<InjectResponse> {
    return this.request('PATCH', url, body, options);
  }

  delete(url: string, options?: RequestOptions): Promise<InjectResponse> {
    return this.request('DELETE', url, undefined, options);
  }
}

/**
 * `api(app).as(user)` returns a client acting as that user; `api(app).anonymous()` sends no identity.
 *
 * Slice 1 identifies the caller with the `x-test-user` header understood by the test-support
 * endpoints. From slice 2 (Better Auth) `as(user)` creates the session record directly in Redis and
 * sends its cookie instead, so tests never go through the sign-in flow (docs/plan.md, "Фикстуры").
 */
export function api(app: NestFastifyApplication): {
  as(user: TestUser | string): ApiClient;
  anonymous(): ApiClient;
} {
  return {
    as: (user) => new ApiClient(app, typeof user === 'string' ? user : user.id),
    anonymous: () => new ApiClient(app, undefined),
  };
}
