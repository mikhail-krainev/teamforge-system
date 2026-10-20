import { Inject, Injectable, type OnModuleInit } from '@nestjs/common';
import { HttpAdapterHost } from '@nestjs/core';
import type { FastifyInstance } from 'fastify';
import { MAX_SOURCE_BYTES } from '../loader/parse-source.js';

/**
 * Teaches Fastify to read `application/yaml` (the body of uploadPlaybook, openapi) as text; the parser
 * of the playbook itself is `parsePlaybookSource`. Registered once, before the server starts; a process
 * without HTTP (the CLI, the worker) has no adapter and skips it.
 */
@Injectable()
export class YamlBodyParser implements OnModuleInit {
  constructor(@Inject(HttpAdapterHost) private readonly host: HttpAdapterHost) {}

  onModuleInit(): void {
    const adapter = this.host.httpAdapter as { getInstance?: () => unknown } | undefined;
    const fastify = adapter?.getInstance?.() as FastifyInstance | undefined;
    if (fastify === undefined || typeof fastify.addContentTypeParser !== 'function') return;
    if (fastify.hasContentTypeParser('application/yaml')) return;
    fastify.addContentTypeParser(
      'application/yaml',
      { parseAs: 'string', bodyLimit: MAX_SOURCE_BYTES },
      (_request, body, done) => {
        done(null, body);
      },
    );
  }
}
