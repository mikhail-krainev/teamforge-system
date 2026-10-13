import type { APIRequestContext } from '@playwright/test';
import { E2E_WEB_URL } from './stack';

/** State-changing requests are checked against APP_ORIGIN (CSRF, docs/architecture.md 13.10). */
export const ORIGIN_HEADERS = { Origin: E2E_WEB_URL } as const;

export interface GithubStatus {
  linked: boolean;
  githubUserId?: number | null;
  login?: string | null;
}

export interface Me {
  id: string;
  status: 'active' | 'deleting';
  consentRequired: boolean;
  github: GithubStatus;
  displayName?: string | null;
  emailMasked?: string | null;
}

export interface CatalogEntry {
  code: string;
  name: string;
  active: boolean;
}

export interface Problem {
  status: number;
  code: string;
  retryAfterSeconds?: number;
}

export interface ApiResult<T> {
  status: number;
  headers: Record<string, string>;
  body: T;
  text: string;
}

/** Parsed JSON (or `undefined` for an empty or non-JSON body) of an API call through the web origin. */
async function result<T>(
  response: Awaited<ReturnType<APIRequestContext['get']>>,
): Promise<ApiResult<T>> {
  const text = await response.text();
  let body: unknown;
  try {
    body = text === '' ? undefined : JSON.parse(text);
  } catch {
    body = undefined;
  }
  return { status: response.status(), headers: response.headers(), body: body as T, text };
}

/** `GET /api/<path>` (path starts with `/v1/...` or `/auth/...`). */
export async function apiGet<T = unknown>(
  request: APIRequestContext,
  path: string,
): Promise<ApiResult<T>> {
  return result<T>(await request.get(`/api${path}`, { headers: ORIGIN_HEADERS }));
}

/** `POST /api/<path>` with a JSON body. */
export async function apiPost<T = unknown>(
  request: APIRequestContext,
  path: string,
  data: unknown,
  headers: Record<string, string> = {},
): Promise<ApiResult<T>> {
  return result<T>(
    await request.post(`/api${path}`, { data, headers: { ...ORIGIN_HEADERS, ...headers } }),
  );
}
