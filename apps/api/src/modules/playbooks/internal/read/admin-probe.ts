import { Inject, Injectable, Optional } from '@nestjs/common';
import type { FastifyRequest } from 'fastify';
import { ActorPolicies, type ActorContext } from '../../../../platform/authz/actor-policies.js';
import { DomainError } from '../../../../platform/errors/domain-error.js';

/**
 * "Is this user an administrator?" for operations open to every signed-in user that show more to an
 * administrator (`getPlaybook`: drafts). The playbooks module may not import `auth`, so it asks the
 * policy of the actor `admin` (registered by `auth` in the platform registry) and reads its verdict.
 */
@Injectable()
export class AdminProbe {
  constructor(
    // Only the HTTP process has the authorization module; elsewhere nobody asks.
    @Optional() @Inject(ActorPolicies) private readonly policies?: ActorPolicies,
  ) {}

  async isAdmin(userId: string): Promise<boolean> {
    const policy = this.policies?.get('admin');
    if (policy === undefined) return false;
    try {
      // The admin policy decides by the user id alone.
      await policy.check({
        operationId: 'getPlaybook',
        request: {} as FastifyRequest,
        authz: { actor: 'admin' },
        userId,
      } satisfies ActorContext);
      return true;
    } catch (error) {
      if (error instanceof DomainError && error.code === 'ADMIN_ONLY') return false;
      throw error;
    }
  }
}
