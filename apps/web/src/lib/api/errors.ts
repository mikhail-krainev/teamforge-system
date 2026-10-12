import type { ErrorCode, Schema } from 'shared';

export type Problem = Partial<Schema<'Problem'>>;

/** Non-2xx HTTP response. `problem` is set when the body is RFC 9457 problem+json. */
export class ApiError extends Error {
  readonly status: number;
  readonly code: ErrorCode | undefined;
  readonly problem: Problem | undefined;
  /** Parsed body of any shape (for example the `Health` body of a 503). */
  readonly body: unknown;
  readonly retryAfterSeconds: number | undefined;

  constructor(init: {
    status: number;
    body: unknown;
    problem?: Problem | undefined;
    retryAfterSeconds?: number | undefined;
  }) {
    super(init.problem?.title ?? `HTTP ${init.status}`);
    this.name = 'ApiError';
    this.status = init.status;
    this.body = init.body;
    this.problem = init.problem;
    this.code = init.problem?.code;
    this.retryAfterSeconds = init.retryAfterSeconds;
  }
}

/** The request never produced a response (offline, DNS, reset connection). */
export class NetworkError extends Error {
  constructor(options?: { cause?: unknown }) {
    super('Network request failed', options);
    this.name = 'NetworkError';
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Recognises a problem body by its stable `code` and numeric `status`. */
export function parseProblem(body: unknown): Problem | undefined {
  if (!isRecord(body)) return undefined;
  if (typeof body.code !== 'string' || typeof body.status !== 'number') return undefined;
  return body as Problem;
}

export function parseRetryAfter(header: string | null): number | undefined {
  if (header === null) return undefined;
  const seconds = Number(header);
  return Number.isFinite(seconds) && seconds >= 0 ? seconds : undefined;
}

function parseBody(text: string): unknown {
  if (text === '') return undefined;
  try {
    return JSON.parse(text);
  } catch {
    return text; // non-JSON body, for example a proxy error page
  }
}

export async function toApiError(response: Response): Promise<ApiError> {
  const body = parseBody(await response.clone().text());
  return new ApiError({
    status: response.status,
    body,
    problem: parseProblem(body),
    retryAfterSeconds: parseRetryAfter(response.headers.get('Retry-After')),
  });
}
