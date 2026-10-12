import {
  type CanActivate,
  type ExecutionContext,
  Inject,
  Injectable,
  Optional,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { FastifyRequest } from 'fastify';
import { ClsService } from 'nestjs-cls';
import { DomainError } from '../errors/domain-error.js';
import { OPERATION_KEY } from '../http/operation.decorator.js';
import {
  ActorPolicies,
  CONSENT_GATE,
  type ConsentGate,
  SESSION_AUTHENTICATOR,
  type SessionAuthenticator,
} from './actor-policies.js';
import { AuthzRegistry } from './authz.registry.js';

/**
 * Global guard, deny by default (architecture 13.14, SEC-03): a handler without `@Authz(operationId)`,
 * with an unknown operation, without `x-authz`, or with an actor that has no policy is refused with
 * 403 (AuthzRegistry already stops the application from starting in these cases; this is the
 * runtime backstop). Then the policy of the operation's `actor` runs: session first when it needs
 * one, then the actor specific check (including the `chain` of nested identifiers).
 */
@Injectable()
export class AuthzGuard implements CanActivate {
  constructor(
    @Inject(Reflector) private readonly reflector: Reflector,
    @Inject(AuthzRegistry) private readonly registry: AuthzRegistry,
    @Inject(ActorPolicies) private readonly policies: ActorPolicies,
    @Inject(ClsService) private readonly cls: ClsService,
    @Optional()
    @Inject(SESSION_AUTHENTICATOR)
    private readonly authenticator?: SessionAuthenticator,
    @Optional() @Inject(CONSENT_GATE) private readonly consentGate?: ConsentGate,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    if (context.getType() !== 'http') return true;
    const operationId = this.reflector.get<string | undefined>(OPERATION_KEY, context.getHandler());
    const authz = operationId === undefined ? undefined : this.registry.get(operationId)?.authz;
    const policy = authz === undefined ? undefined : this.policies.get(authz.actor);
    if (operationId === undefined || authz === undefined || policy === undefined) {
      throw new DomainError('FORBIDDEN', 403);
    }
    const request = context.switchToHttp().getRequest<FastifyRequest>();
    const userId = policy.requiresSession ? await this.requireSession(request) : undefined;
    await policy.check({ operationId, request, authz, userId });
    // Consent comes before body validation: a user without consent learns nothing about schemas.
    if (userId !== undefined) await this.consentGate?.check(operationId, userId);
    return true;
  }

  private async requireSession(request: FastifyRequest): Promise<string> {
    const userId = await this.authenticator?.authenticate(request);
    if (userId === undefined) throw new DomainError('UNAUTHENTICATED', 401);
    this.cls.set('userId', userId);
    return userId;
  }
}
