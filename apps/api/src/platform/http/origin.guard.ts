import { type CanActivate, type ExecutionContext, Inject, Injectable } from '@nestjs/common';
import type { FastifyRequest } from 'fastify';
import { APP_CONFIG } from '../config/config.module.js';
import type { AppConfig } from '../config/config.js';
import { DomainError } from '../errors/domain-error.js';

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

function headerValue(value: string | string[] | undefined): string {
  return (Array.isArray(value) ? value[0] : value) ?? '';
}

function originOf(value: string): string | undefined {
  try {
    return new URL(value).origin;
  } catch {
    return undefined;
  }
}

/**
 * CSRF defence of architecture 13.10 (SEC-24) on top of `SameSite=Lax`: a state-changing request
 * that carries cookies must come from `APP_ORIGIN` (`Origin`, else `Referer`). Without either
 * header it is refused too. Requests without cookies (webhooks, API clients) carry no ambient
 * credentials and pass.
 */
@Injectable()
export class OriginGuard implements CanActivate {
  constructor(@Inject(APP_CONFIG) private readonly config: AppConfig) {}

  canActivate(context: ExecutionContext): boolean {
    if (context.getType() !== 'http') return true;
    const request = context.switchToHttp().getRequest<FastifyRequest>();
    if (SAFE_METHODS.has(request.method) || request.headers.cookie === undefined) return true;
    const claimed = headerValue(request.headers.origin) || headerValue(request.headers.referer);
    if (claimed === '' || originOf(claimed) !== originOf(this.config.APP_ORIGIN)) {
      throw new DomainError('FORBIDDEN', 403);
    }
    return true;
  }
}
