import { Readable } from 'node:stream';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import type { FastifyRequest } from 'fastify';
import { AuthzRegistry } from '../authz/authz.registry.js';
import { DomainError } from '../errors/domain-error.js';
import {
  isLoopbackClient,
  RateLimiter,
  type RateLimitCategory,
} from '../ratelimit/rate-limiter.js';
import { fastifyPath } from './multipart-gate.js';

const MEBIBYTE = 1024 * 1024;

interface RawBodyOperation {
  /** Larger bodies are refused with 413 before they are buffered (architecture 7.3). */
  maxBytes: number;
  /** Per source address, counted before the body is read. */
  ipLimit: RateLimitCategory;
}

/** Operations whose signature is computed over the exact bytes the sender wrote (FR-GH-03). */
export const RAW_BODY_OPERATIONS: Readonly<Record<string, RawBodyOperation>> = {
  receiveGithubWebhook: { maxBytes: 5 * MEBIBYTE, ipLimit: 'githubWebhookIp' },
};

const RAW_BODIES = new WeakMap<object, Buffer>();

/** The body of the request as it arrived, byte for byte; empty when the route keeps no raw body. */
export function rawBodyOf(request: FastifyRequest): Buffer {
  return RAW_BODIES.get(request) ?? Buffer.alloc(0);
}

const PLACEHOLDER_BODY = '{}';

function tooLarge(): DomainError {
  return new DomainError('VALIDATION_FAILED', 413, { detail: 'body_too_large' });
}

async function readAll(payload: AsyncIterable<Buffer | string>, max: number): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of payload) {
    const part = typeof chunk === 'string' ? Buffer.from(chunk) : chunk;
    size += part.length;
    if (size > max) throw tooLarge();
    chunks.push(part);
  }
  return Buffer.concat(chunks);
}

/**
 * Keeps the raw body of the routes that are signed over it. The body is read here, stored for the
 * policy of the route (`rawBodyOf`) and replaced by `{}` for Fastify: the signature is checked before
 * anything is parsed (an unsigned body must never reach a JSON parser, FR-GH-03), and a re-serialised
 * body would not match the digest. The per-address limit runs before the first byte is read.
 */
export function registerRawBodyGate(app: NestFastifyApplication, apiPrefix: string): void {
  const registry = app.get(AuthzRegistry, { strict: false });
  const limiter = app.get(RateLimiter, { strict: false });
  const routes = new Map<string, RawBodyOperation>();
  for (const [operationId, policy] of Object.entries(RAW_BODY_OPERATIONS)) {
    const spec = registry.get(operationId);
    if (spec === undefined) continue;
    routes.set(`${spec.method.toUpperCase()} ${fastifyPath(apiPrefix, spec)}`, policy);
  }
  const fastify = app.getHttpAdapter().getInstance();
  fastify.addHook('onRoute', (route) => {
    const methods = Array.isArray(route.method) ? route.method : [route.method];
    for (const method of methods) {
      const policy = routes.get(`${method} ${route.url}`);
      if (policy !== undefined) route.bodyLimit = policy.maxBytes;
    }
  });
  fastify.addHook('preParsing', async (request, reply, payload) => {
    const policy = routes.get(`${request.method} ${request.routeOptions?.url}`);
    if (policy === undefined) return payload;
    try {
      if (!isLoopbackClient(request.ip)) {
        await limiter.enforce(policy.ipLimit, limiter.ipSubject(request.ip));
      }
      const declared = Number(request.headers['content-length']);
      if (Number.isFinite(declared) && declared > policy.maxBytes) throw tooLarge();
      RAW_BODIES.set(request, await readAll(payload, policy.maxBytes));
    } catch (error) {
      void reply.header('Connection', 'close');
      throw error;
    }
    // The placeholder is not what the sender declared: Fastify must not compare the two lengths.
    request.headers['content-type'] = 'application/json';
    delete request.headers['content-length'];
    const replacement = Readable.from([Buffer.from(PLACEHOLDER_BODY)]);
    return replacement;
  });
}
