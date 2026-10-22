import { type DynamicModule, Inject, Injectable, Module, type OnModuleInit } from '@nestjs/common';
import { HttpAdapterHost } from '@nestjs/core';
import type { FastifyInstance } from 'fastify';
import { ClsService } from 'nestjs-cls';
import { LoggerModule, PinoLogger } from 'nestjs-pino';
import type { DestinationStream } from 'pino';
import { APP_CONFIG } from '../config/config.module.js';
import type { AppConfig } from '../config/config.js';
import { loggedUserId } from './request-line.js';
import { REDACT_PATHS, serializeErr, serializeReq, serializeRes } from './serializers.js';

export interface LoggingOptions {
  /** Test hook: captures log lines instead of writing to stdout. */
  stream?: DestinationStream;
}

export const LOGGING_OPTIONS = Symbol('LOGGING_OPTIONS');

/** Writes one structured line per finished HTTP request (architecture 13.4). */
@Injectable()
export class RequestLogHook implements OnModuleInit {
  constructor(
    @Inject(HttpAdapterHost) private readonly adapterHost: HttpAdapterHost,
    @Inject(PinoLogger) private readonly logger: PinoLogger,
  ) {}

  onModuleInit(): void {
    const fastify = this.adapterHost.httpAdapter?.getInstance<FastifyInstance>();
    if (typeof fastify?.addHook !== 'function') return;
    fastify.addHook('onResponse', (request, reply, done) => {
      const status = reply.statusCode;
      const line = {
        request_id: request.id,
        route: request.routeOptions?.url ?? 'unmatched',
        operation_id: request.tf?.operationId,
        user_id: loggedUserId(request.tf),
        status,
        duration_ms: Math.round(reply.elapsedTime),
      };
      if (status >= 500) this.logger.error(line, 'request failed');
      else this.logger.info(line, 'request completed');
      done();
    });
  }
}

@Module({})
export class LoggingModule {
  static forRoot(options: LoggingOptions = {}): DynamicModule {
    return {
      module: LoggingModule,
      imports: [
        LoggerModule.forRootAsync({
          inject: [APP_CONFIG, ClsService],
          useFactory: (config: AppConfig, cls: ClsService) => {
            const pinoOptions = {
              level: config.LOG_LEVEL,
              autoLogging: false,
              quietReqLogger: true,
              base: { role: config.role },
              timestamp: () => `,"ts":"${new Date().toISOString()}"`,
              formatters: { level: (label: string) => ({ level: label }) },
              redact: { paths: REDACT_PATHS, censor: '[redacted]' },
              // pino-http would otherwise run pino's std error serializer FIRST and hand ours a plain
              // object (message with SQL parameters included, no Error instance): ours gets the real error.
              wrapSerializers: false,
              serializers: { req: serializeReq, res: serializeRes, err: serializeErr },
              mixin: () => (cls.isActive() ? { request_id: cls.get('requestId') } : {}),
            };
            return { pinoHttp: options.stream ? [pinoOptions, options.stream] : pinoOptions };
          },
        }),
      ],
      providers: [{ provide: LOGGING_OPTIONS, useValue: options }, RequestLogHook],
      exports: [LoggerModule],
    };
  }
}
