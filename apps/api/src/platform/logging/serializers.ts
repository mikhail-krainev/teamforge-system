/**
 * Request/response/error serializers that never emit URL, query string or headers: tokens, OAuth
 * `code`/`state` and presigned signatures can appear there (architecture 13.4, SEC-07).
 */
interface RequestLike {
  method?: string;
  id?: unknown;
  routeOptions?: { url?: string };
  raw?: RequestLike;
}

export function serializeReq(req: RequestLike): Record<string, unknown> {
  return {
    method: req.method ?? req.raw?.method,
    route: req.routeOptions?.url ?? req.raw?.routeOptions?.url ?? 'unmatched',
    request_id: req.id ?? req.raw?.id,
  };
}

export function serializeRes(res: { statusCode?: number }): Record<string, unknown> {
  return { statusCode: res.statusCode };
}

/** Error serializer without request/config details that HTTP clients attach (URLs, headers). */
export function serializeErr(err: unknown): Record<string, unknown> {
  if (!(err instanceof Error)) return { message: String(err) };
  const withCode = err as Error & { code?: unknown };
  return {
    type: err.name,
    message: err.message,
    code: typeof withCode.code === 'string' ? withCode.code : undefined,
    stack: err.stack,
  };
}

export const REDACT_PATHS = [
  'req.headers.cookie',
  'req.headers.authorization',
  'req.headers["x-hub-signature-256"]',
  '*.email',
  '*.token',
  '*.text',
  '*.extractedText',
  '*.outcome',
];
