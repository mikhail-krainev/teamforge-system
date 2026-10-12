import type { IncomingMessage } from 'node:http';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { Logger } from 'nestjs-pino';
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

/** Common HTTP configuration shared by main.ts and the test harness. */
export function configureHttpApp(app: NestFastifyApplication): void {
  app.setGlobalPrefix(API_PREFIX);
  app.useLogger(app.get(Logger));
  app
    .getHttpAdapter()
    .getInstance()
    .addHook('onRequest', (request, reply, done) => {
      void reply.header('X-Request-Id', request.id);
      done();
    });
}
