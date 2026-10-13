import { DomainError } from '../../../../platform/errors/domain-error.js';
import type { ActorPolicy } from '../../../../platform/authz/actor-policies.js';
import type { AuthApi } from '../../public.js';

/** Actor `admin` (architecture 13.14): a signed-in, active user flagged `is_admin`. */
export function adminPolicy(auth: Pick<AuthApi, 'isAdmin'>): ActorPolicy {
  return {
    requiresSession: true,
    async check({ userId }) {
      if (userId === undefined || !(await auth.isAdmin(userId))) {
        throw new DomainError('ADMIN_ONLY', 403);
      }
    },
  };
}
