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

const PG_CODE = /^[0-9A-Z]{5}$/;
const MAX_CAUSE_DEPTH = 5;

/** Fields of a PostgreSQL error that are safe to log: identifiers only, never values. */
const PG_SAFE_FIELDS = [
  'severity',
  'constraint_name',
  'table_name',
  'schema_name',
  'column_name',
  'routine',
] as const;

function causeChain(err: Error): Error[] {
  const chain: Error[] = [];
  for (let current: unknown = err; current instanceof Error && chain.length < MAX_CAUSE_DEPTH;) {
    chain.push(current);
    current = current.cause;
  }
  return chain;
}

function pgErrorOf(chain: readonly Error[]): (Error & Record<string, unknown>) | undefined {
  return chain.find((e) => {
    const code = (e as Error & { code?: unknown }).code;
    return typeof code === 'string' && PG_CODE.test(code);
  }) as (Error & Record<string, unknown>) | undefined;
}

/** drizzle-orm's DrizzleQueryError carries the SQL text and the bound parameter values. */
function isQueryError(err: Error): boolean {
  const candidate = err as Error & { query?: unknown; params?: unknown };
  return typeof candidate.query === 'string' && Array.isArray(candidate.params);
}

function stackFrames(err: Error): string {
  const frames = (err.stack ?? '').split(/\r?\n/).filter((line) => /^\s+at\s/.test(line));
  return [err.name, ...frames].join('\n');
}

/**
 * Database errors are logged WITHOUT their message, stack header, SQL text, parameters or the
 * PostgreSQL `detail`/`message` fields: all of them can carry values (emails, tokens, resume text),
 * for example `Failed query: INSERT ... params: alice@example.com,<token>` or
 * `Key (email)=(alice@example.com) already exists` (SEC-07, architecture 13.4). Only the error type,
 * the SQLSTATE code and object names are kept.
 */
function serializeDbError(err: Error, pg: (Error & Record<string, unknown>) | undefined) {
  const db: Record<string, unknown> = { code: pg?.code };
  for (const field of PG_SAFE_FIELDS) {
    if (typeof pg?.[field] === 'string') db[field] = pg[field];
  }
  return { type: err.name, message: 'database query failed', db, stack: stackFrames(err) };
}

/** Error serializer without request/config details that HTTP clients attach (URLs, headers). */
export function serializeErr(err: unknown): Record<string, unknown> {
  if (!(err instanceof Error)) return { message: String(err) };
  const chain = causeChain(err);
  const pg = pgErrorOf(chain);
  if (pg !== undefined || chain.some(isQueryError)) return serializeDbError(err, pg);
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
