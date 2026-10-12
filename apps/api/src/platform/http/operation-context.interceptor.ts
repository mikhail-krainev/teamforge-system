import {
  type CallHandler,
  type ExecutionContext,
  Inject,
  Injectable,
  type NestInterceptor,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { FastifyRequest } from 'fastify';
import { ClsService } from 'nestjs-cls';
import { type Observable, finalize } from 'rxjs';
import { OPERATION_KEY } from './operation.decorator.js';

/** Records operationId (and user id once known) on the request for the access log line. */
@Injectable()
export class OperationContextInterceptor implements NestInterceptor {
  constructor(
    @Inject(Reflector) private readonly reflector: Reflector,
    @Inject(ClsService) private readonly cls: ClsService,
  ) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    if (context.getType() !== 'http') return next.handle();
    const request = context.switchToHttp().getRequest<FastifyRequest>();
    const operationId = this.reflector.get<string | undefined>(OPERATION_KEY, context.getHandler());
    this.cls.set('operationId', operationId);
    request.tf = { operationId };
    return next.handle().pipe(
      finalize(() => {
        request.tf = { operationId, userId: this.cls.get('userId') };
      }),
    );
  }
}
