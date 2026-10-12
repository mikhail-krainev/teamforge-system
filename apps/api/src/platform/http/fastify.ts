import type { IncomingMessage } from 'node:http';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { Logger } from 'nestjs-pino';
import { APP_CONFIG } from '../config/config.module.js';
import type { AppConfig } from '../config/config.js';
import { resolveRequestId } from './request-id.js';
import { buildTrustProxy } from './trust-proxy.js';

export const API_PREFIX = 'api';

/**
 * Fastify with an explicit trustProxy list (SEC-16) and the request id resolved before anything
 * else runs: X-Request-Id when valid, otherwise a new UUID v7. The id is stored on the raw
 * request so that the CLS middleware and loggers see the same value.
 */
export function buildFastifyAdapter(config: AppConfig): FastifyAdapter {
  return new FastifyAdapter({
    trustProxy: buildTrustProxy(config.TRUSTED_PROXY_CIDRS),
    requestIdHeader: false,
    genReqId: (raw: IncomingMessage) => {
      const id = resolveRequestId(raw.headers['x-request-id']);
      raw.id = id;
      return id;
    },
  });
}

/**
 * Response headers of the JSON API (architecture 13.10): the API serves data, never documents, so
 * nothing may be framed, sniffed, cached or embedded cross-origin. HSTS only in production (a
 * browser ignores it on plain http, and a development host must not pin https).
 */
export function securityHeaders(production: boolean): Record<string, string> {
  return {
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
    'Content-Security-Policy': "default-src 'none'; frame-ancestors 'none'",
    'Referrer-Policy': 'no-referrer',
    'Cross-Origin-Resource-Policy': 'same-origin',
    'Cache-Control': 'no-store',
    ...(production ? { 'Strict-Transport-Security': 'max-age=31536000; includeSubDomains' } : {}),
  };
}

/** Common HTTP configuration shared by main.ts and the test harness. */
export function configureHttpApp(app: NestFastifyApplication): void {
  app.setGlobalPrefix(API_PREFIX);
  app.useLogger(app.get(Logger));
  const headers = securityHeaders(app.get<AppConfig>(APP_CONFIG).NODE_ENV === 'production');
  const fastify = app.getHttpAdapter().getInstance();
  fastify.addHook('onRequest', (request, reply, done) => {
    void reply.header('X-Request-Id', request.id);
    done();
  });
  // onSend also covers 404s and problem+json errors produced outside the route handler.
  fastify.addHook('onSend', (_request, reply, payload, done) => {
    for (const [name, value] of Object.entries(headers)) {
      if (!reply.hasHeader(name)) void reply.header(name, value);
    }
    done(null, payload);
  });
}
