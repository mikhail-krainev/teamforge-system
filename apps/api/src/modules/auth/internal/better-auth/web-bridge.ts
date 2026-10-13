import type { FastifyReply, FastifyRequest } from 'fastify';
import type { Auth } from './create-auth.js';

/** Connection-level headers that must not be copied into the Web `Request`. */
const SKIPPED_HEADERS = new Set(['content-length', 'transfer-encoding', 'connection', 'host']);

/** Fastify headers as a Web `Headers`; `x-forwarded-for` is replaced by the trusted client IP. */
export function toWebHeaders(request: FastifyRequest): Headers {
  const headers = new Headers();
  for (const [name, value] of Object.entries(request.headers)) {
    if (value === undefined || SKIPPED_HEADERS.has(name)) continue;
    for (const item of Array.isArray(value) ? value : [value]) headers.append(name, item);
  }
  headers.set('x-forwarded-for', request.ip);
  return headers;
}

function toWebRequest(request: FastifyRequest, baseOrigin: string): Request {
  const hasBody = request.method !== 'GET' && request.method !== 'HEAD';
  const headers = toWebHeaders(request);
  const body = hasBody && request.body !== undefined ? JSON.stringify(request.body) : undefined;
  if (body !== undefined && !headers.has('content-type')) {
    headers.set('content-type', 'application/json');
  }
  return new Request(new URL(request.url, baseOrigin), { method: request.method, headers, body });
}

/**
 * Hands a request to Better Auth (`auth.handler`) and writes its Web `Response` into the Fastify
 * reply: status, headers (several `Set-Cookie` lines kept apart) and the body as text. Fastify has
 * already parsed the JSON body, so it is serialized again.
 */
export async function forwardToAuth(
  auth: Auth,
  baseOrigin: string,
  request: FastifyRequest,
  reply: FastifyReply,
  mapLocation: (location: string) => string = (location) => location,
): Promise<void> {
  const response = await auth.handler(toWebRequest(request, baseOrigin));
  void reply.status(response.status);
  const cookies = response.headers.getSetCookie();
  response.headers.forEach((value, name) => {
    if (name === 'location') void reply.header(name, mapLocation(value));
    else if (name !== 'set-cookie' && name !== 'content-length') void reply.header(name, value);
  });
  if (cookies.length > 0) void reply.header('set-cookie', cookies);
  const text = await response.text();
  await reply.send(text === '' ? undefined : text);
}
