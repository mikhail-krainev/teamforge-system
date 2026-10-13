import { Inject, Injectable } from '@nestjs/common';
import { ClsService } from 'nestjs-cls';
import type { FastifyRequest } from 'fastify';
import type { SessionAuthenticator } from '../../../../platform/authz/actor-policies.js';
import type { Auth } from '../better-auth/create-auth.js';
import { AUTH } from '../better-auth/tokens.js';
import { toWebHeaders } from '../better-auth/web-bridge.js';

/**
 * Resolves the signed-in user of a request from the Better Auth session cookie (Redis). Used by
 * the global AuthzGuard for every operation whose actor needs a session. A deleted account has no
 * valid session (all sessions are revoked when personal data is erased).
 */
@Injectable()
export class BetterAuthSessionAuthenticator implements SessionAuthenticator {
  constructor(
    @Inject(AUTH) private readonly auth: Auth,
    @Inject(ClsService) private readonly cls: ClsService,
  ) {}

  async authenticate(request: FastifyRequest): Promise<string | undefined> {
    const result = await this.auth.api.getSession({ headers: toWebHeaders(request) });
    if (result === null) return undefined;
    const status = (result.user as { status?: string }).status;
    if (status === 'deleted') return undefined;
    // Freshness of the sign-in (requestDeletion needs a session younger than freshAge).
    this.cls.set('sessionCreatedAt', new Date(result.session.createdAt).getTime());
    return result.user.id;
  }
}
