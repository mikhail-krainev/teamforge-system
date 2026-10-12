import { type CanActivate, type ExecutionContext, Inject, Injectable } from '@nestjs/common';
import type { FastifyRequest } from 'fastify';
import { ClsService } from 'nestjs-cls';
import { DomainError } from '../errors/domain-error.js';

/** Test-only stand-in for the session guard: the user id comes from `X-Test-User`. */
@Injectable()
export class TestUserGuard implements CanActivate {
  constructor(@Inject(ClsService) private readonly cls: ClsService) {}

  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest<FastifyRequest>();
    const header = request.headers['x-test-user'];
    const userId = Array.isArray(header) ? header[0] : header;
    if (userId === undefined) throw new DomainError('UNAUTHENTICATED', 401);
    this.cls.set('userId', userId);
    return true;
  }
}
