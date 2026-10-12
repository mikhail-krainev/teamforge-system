import { type CanActivate, type ExecutionContext, Inject, Injectable } from '@nestjs/common';
import type { FastifyRequest } from 'fastify';
import { isLoopbackClient, RateLimiter } from '../../../../platform/ratelimit/rate-limiter.js';

/**
 * C-32: 10 sign-in attempts per 15 minutes per IP (architecture 13.6), counted before the request
 * reaches Better Auth. Runs after the global guards, so malformed requests are not counted. A
 * request whose client address is the loopback itself (a process inside the container, never a
 * browser: proxied clients arrive with their own address, SEC-16) is not counted.
 */
@Injectable()
export class LoginRateLimitGuard implements CanActivate {
  constructor(@Inject(RateLimiter) private readonly limiter: RateLimiter) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<FastifyRequest>();
    if (!isLoopbackClient(request.ip)) {
      await this.limiter.enforce('authLogin', this.limiter.ipSubject(request.ip));
    }
    return true;
  }
}
