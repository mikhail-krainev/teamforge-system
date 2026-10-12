import { type ArgumentsHost, Catch, type ExceptionFilter, Inject } from '@nestjs/common';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { PinoLogger } from 'nestjs-pino';
import { IdempotentReplay } from './domain-error.js';
import { toProblem } from './problem.js';

export const PROBLEM_CONTENT_TYPE = 'application/problem+json';

/** Global filter: every error leaves the API as application/problem+json. */
@Catch()
export class ProblemFilter implements ExceptionFilter {
  constructor(@Inject(PinoLogger) private readonly logger: PinoLogger) {}

  catch(exception: unknown, host: ArgumentsHost): void {
    const http = host.switchToHttp();
    const reply = http.getResponse<FastifyReply>();
    const request = http.getRequest<FastifyRequest>();
    if (exception instanceof IdempotentReplay) {
      this.sendReplay(reply, exception);
      return;
    }
    const problem = toProblem(exception, {
      instance: request.routeOptions?.url ?? '/',
      requestId: String(request.id),
    });
    if (problem.unexpected) {
      this.logger.error({ err: exception, request_id: request.id }, 'Unhandled exception');
    }
    for (const [name, value] of Object.entries(problem.headers)) void reply.header(name, value);
    void reply
      .status(problem.status)
      .header('content-type', PROBLEM_CONTENT_TYPE)
      .send(problem.body);
  }

  private sendReplay(reply: FastifyReply, replay: IdempotentReplay): void {
    void reply.header('Idempotent-Replayed', 'true');
    if (replay.status >= 400) void reply.header('content-type', PROBLEM_CONTENT_TYPE);
    void reply.status(replay.status).send(replay.body);
  }
}
