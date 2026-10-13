import { type CanActivate, type ExecutionContext, Inject, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { FastifyRequest } from 'fastify';
import { DomainError } from '../errors/domain-error.js';
import { OPERATION_KEY } from '../http/operation.decorator.js';
import { AuthzRegistry } from './authz.registry.js';

/**
 * Checks path, query and JSON body of every request against the schema of its operation
 * (architecture 13.3, ADR-0007). Runs after AuthzGuard, so callers without the right to use an
 * operation learn nothing about its schema. Unknown body fields are refused with 400 (nothing is removed silently); query/path values are
 * coerced IN PLACE.
 */
@Injectable()
export class ValidationGuard implements CanActivate {
  constructor(
    @Inject(Reflector) private readonly reflector: Reflector,
    @Inject(AuthzRegistry) private readonly registry: AuthzRegistry,
  ) {}

  canActivate(context: ExecutionContext): boolean {
    if (context.getType() !== 'http') return true;
    const operationId = this.reflector.get<string | undefined>(OPERATION_KEY, context.getHandler());
    const validators = this.registry.requestValidators;
    if (operationId === undefined || validators === undefined || !validators.has(operationId)) {
      throw new DomainError('FORBIDDEN', 403);
    }
    const request = context.switchToHttp().getRequest<FastifyRequest>();
    const errors = validators.validate(operationId, {
      params: request.params,
      query: request.query,
      body: request.body,
    });
    if (errors.length > 0) throw new DomainError('VALIDATION_FAILED', 400, { errors });
    return true;
  }
}
