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
import { AuthzRegistry } from '../authz/authz.registry.js';
import { catchError, defer, from, mergeMap, type Observable, throwError } from 'rxjs';
import type { IdempotencyContext } from '../context/cls-store.js';
import { DomainError, IdempotentReplay, InvariantError } from '../errors/domain-error.js';
import { NO_IDEMPOTENCY_KEY, OPERATION_KEY } from '../http/operation.decorator.js';
import { type BeginDecision, IdempotencyService } from './idempotency.service.js';

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** Nest's metadata key written by @HttpCode(). */
const HTTP_CODE_METADATA = '__httpCode__';

function readKey(request: FastifyRequest): string {
  const header = request.headers['idempotency-key'];
  const value = Array.isArray(header) ? header[0] : header;
  if (value === undefined || value === '') throw new DomainError('IDEMPOTENCY_KEY_MISSING', 400);
  if (!UUID.test(value)) {
    throw new DomainError('VALIDATION_FAILED', 400, {
      errors: [{ pointer: '/headers/Idempotency-Key', code: 'format', message: 'Must be a UUID' }],
    });
  }
  return value.toLowerCase();
}

/** FR-WORK-08 on every mutating operation of /v1 (architecture 12.4, ADR-0004). */
@Injectable()
export class IdempotencyInterceptor implements NestInterceptor {
  constructor(
    @Inject(Reflector) private readonly reflector: Reflector,
    @Inject(ClsService) private readonly cls: ClsService,
    @Inject(IdempotencyService) private readonly service: IdempotencyService,
    @Inject(AuthzRegistry) private readonly registry: AuthzRegistry,
  ) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    if (context.getType() !== 'http') return next.handle();
    const request = context.switchToHttp().getRequest<FastifyRequest>();
    const handler = context.getHandler();
    if (SAFE_METHODS.has(request.method)) return next.handle();
    if (this.reflector.get<boolean | undefined>(NO_IDEMPOTENCY_KEY, handler) === true) {
      return next.handle();
    }
    const operationId = this.reflector.get<string | undefined>(OPERATION_KEY, handler);
    if (operationId === undefined) {
      throw new InvariantError(`Mutating handler ${handler.name} has no @Authz`);
    }
    const userId = this.cls.get('userId');
    if (userId === undefined) return this.withoutUser(operationId, handler.name, next);
    const key = readKey(request);
    const successStatus =
      this.reflector.get<number | undefined>(HTTP_CODE_METADATA, handler) ??
      (request.method === 'POST' ? 201 : 200);
    return defer(() =>
      this.service.begin({ userId, key, operationId, params: request.params, body: request.body }),
    ).pipe(
      mergeMap((decision) => this.execute(decision, { userId, key, successStatus }, request, next)),
    );
  }

  /**
   * A mutating operation without a signed-in user keeps no idempotency scope. That is legitimate
   * only for public operations (actor `public`) or an explicit @NoIdempotency(); anything else
   * means a guard did not set the user and must not silently lose idempotency (S1R-06, fail closed).
   */
  private withoutUser(
    operationId: string,
    handlerName: string,
    next: CallHandler,
  ): Observable<unknown> {
    if (this.registry.get(operationId)?.authz?.actor === 'public') return next.handle();
    throw new InvariantError(
      `Mutating handler ${handlerName} runs without a user: mark it @NoIdempotency() or make it public`,
    );
  }

  private execute(
    decision: BeginDecision,
    claim: { userId: string; key: string; successStatus: number },
    request: FastifyRequest,
    next: CallHandler,
  ): Observable<unknown> {
    if (decision.kind === 'replay') {
      return throwError(() => new IdempotentReplay(decision.status, decision.body));
    }
    const ctx: IdempotencyContext = {
      ...claim,
      lockToken: decision.lockToken,
      completedInTx: false,
      committed: false,
    };
    this.cls.set('idempotency', ctx);
    const problemContext = {
      instance: request.routeOptions?.url ?? '/',
      requestId: String(request.id),
    };
    return next.handle().pipe(
      mergeMap((value) => from(this.service.afterSuccess(ctx, value).then(() => value))),
      catchError((error: unknown) =>
        from(this.service.afterFailure(ctx, error, problemContext)).pipe(
          mergeMap(() => throwError(() => error)),
        ),
      ),
    );
  }
}
