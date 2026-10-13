import { Transform } from 'node:stream';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import type { FastifyRequest } from 'fastify';
import {
  ActorPolicies,
  CONSENT_GATE,
  type ConsentGate,
  SESSION_AUTHENTICATOR,
  type SessionAuthenticator,
} from '../authz/actor-policies.js';
import { AuthzRegistry } from '../authz/authz.registry.js';
import type { OperationSpec } from '../authz/contract-operations.js';
import { DomainError } from '../errors/domain-error.js';
import { IdempotencyStore } from '../idempotency/idempotency.store.js';
import { RateLimiter } from '../ratelimit/rate-limiter.js';
import {
  DEFAULT_MULTIPART_BODY_BYTES,
  MULTIPART_OPERATIONS,
  type MultipartOperationPolicy,
} from './multipart.js';

const MULTIPART_TYPE = /^multipart\/form-data\b/i;

function optionalProvider<T>(app: NestFastifyApplication, token: symbol): T | undefined {
  try {
    return app.get<T>(token, { strict: false });
  } catch {
    return undefined;
  }
}

/** Fastify route pattern of a contract operation: `/v1/x/{id}` -> `/api/v1/x/:id`. */
function fastifyPath(prefix: string, spec: OperationSpec): string {
  return `/${prefix}${spec.path}`.replaceAll(/\{([A-Za-z0-9_]+)\}/g, ':$1');
}

/** Stream that fails with 413 once more than `max` bytes have passed through it. */
export function byteLimit(max: number): Transform {
  let seen = 0;
  return new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      seen += chunk.length;
      if (seen > max) callback(new DomainError('FILE_TOO_LARGE', 413));
      else callback(null, chunk);
    },
  });
}

const KEY_FORMAT = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * True when the request repeats an Idempotency-Key of this user whose response is already stored
 * for THIS operation. The request hash is derived from the parsed body, which is not available
 * before the body is read, so only the operationId is compared here; the interceptor still
 * compares the full hash and answers 422 IDEMPOTENCY_KEY_REUSED for a different payload.
 */
async function isCompletedReplay(
  store: IdempotencyStore,
  request: FastifyRequest,
  userId: string,
  operationId: string,
): Promise<boolean> {
  const header = request.headers['idempotency-key'];
  const key = Array.isArray(header) ? header[0] : header;
  if (key === undefined || !KEY_FORMAT.test(key)) return false;
  const row = await store.find(userId, key.toLowerCase());
  return (
    row?.status === 'completed' &&
    row.operationId === operationId &&
    !row.responseProvisional &&
    row.expiresAt > new Date()
  );
}

interface Admission {
  specFor(request: FastifyRequest): OperationSpec | undefined;
  admit(request: FastifyRequest, spec: OperationSpec): Promise<void>;
}

function buildAdmission(app: NestFastifyApplication, apiPrefix: string): Admission {
  const registry = app.get(AuthzRegistry, { strict: false });
  const policies = app.get(ActorPolicies, { strict: false });
  const limiter = app.get(RateLimiter, { strict: false });
  const idempotency = app.get(IdempotencyStore, { strict: false });
  const authenticator = optionalProvider<SessionAuthenticator>(app, SESSION_AUTHENTICATOR);
  const consent = optionalProvider<ConsentGate>(app, CONSENT_GATE);
  return {
    specFor: (request) =>
      registry
        .multipartOperations()
        .find(
          (spec) =>
            spec.method === request.method.toLowerCase() &&
            fastifyPath(apiPrefix, spec) === request.routeOptions?.url,
        ),
    async admit(request, spec) {
      const authz = spec.authz;
      const policy = authz === undefined ? undefined : policies.get(authz.actor);
      if (authz === undefined || policy === undefined) throw new DomainError('FORBIDDEN', 403);
      const userId = policy.requiresSession
        ? await authenticator?.authenticate(request)
        : undefined;
      if (policy.requiresSession && userId === undefined) {
        throw new DomainError('UNAUTHENTICATED', 401);
      }
      await policy.check({ operationId: spec.operationId, request, authz, userId });
      if (userId === undefined) return;
      await consent?.check(spec.operationId, userId);
      const category = MULTIPART_OPERATIONS[spec.operationId]?.rateLimit;
      if (category !== undefined) {
        try {
          await limiter.assertBelowLimit(category, limiter.userSubject(userId));
        } catch (error) {
          // Only a refusal by the limit itself may be waived; any other failure (Redis down)
          // propagates so that the gate fails closed.
          if (!(error instanceof DomainError) || error.code !== 'RATE_LIMITED') throw error;
          // A repeat of an already accepted request of the same operation is a replay of the
          // stored answer, not new work: the limit does not apply to it (FR-WORK-08).
          if (!(await isCompletedReplay(idempotency, request, userId, spec.operationId))) {
            throw error;
          }
        }
      }
    },
  };
}

/**
 * Admission of `multipart/form-data` before Fastify reads a byte of the body (S2SEC-01). The
 * parser buffers the body, and Nest guards run only after parsing, so the checks of AuthzGuard are
 * repeated here in the `preParsing` hook, in this order:
 *  1. only a route that the contract declares as multipart (uploadResume, uploadArtifactFile);
 *     anything else -> 415 FILE_TYPE_REJECTED;
 *  2. session -> 401, route rights, consent -> 403;
 *  3. the per-user rate limit of the route (C-33, C-34) -> 429, without counting a hit;
 *  4. Content-Length above the route's cut-off -> 413; a body without it is cut by a counting stream.
 * A refusal closes the connection so that the unread body is not pumped through the server.
 */
export function registerMultipartGate(app: NestFastifyApplication, apiPrefix: string): void {
  const { specFor, admit } = buildAdmission(app, apiPrefix);
  app
    .getHttpAdapter()
    .getInstance()
    .addHook('preParsing', async (request, reply, payload) => {
      if (!MULTIPART_TYPE.test(String(request.headers['content-type'] ?? ''))) return payload;
      try {
        const spec = specFor(request);
        if (spec === undefined) {
          throw new DomainError('FILE_TYPE_REJECTED', 415, { detail: 'multipart_not_accepted' });
        }
        await admit(request, spec);
        const policy: MultipartOperationPolicy | undefined = MULTIPART_OPERATIONS[spec.operationId];
        const max = policy?.maxBodyBytes ?? DEFAULT_MULTIPART_BODY_BYTES;
        const declared = Number(request.headers['content-length']);
        if (Number.isFinite(declared) && declared > max) {
          throw new DomainError('FILE_TOO_LARGE', 413);
        }
        return payload.pipe(byteLimit(max));
      } catch (error) {
        void reply.header('Connection', 'close');
        throw error;
      }
    });
}
