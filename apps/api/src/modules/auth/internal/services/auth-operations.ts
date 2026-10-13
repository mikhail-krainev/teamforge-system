import { Inject, Injectable, Optional, type OnModuleInit } from '@nestjs/common';
import { ActorPolicies } from '../../../../platform/authz/actor-policies.js';
import { AuthzRegistry } from '../../../../platform/authz/authz.registry.js';
import type { OperationSpec } from '../../../../platform/authz/contract-operations.js';
import { AuthService } from './auth.service.js';
import { adminPolicy } from './admin-policy.js';

/** Operations of this module that are not in the public contract. */
export const AUTH_EXTRA_OPERATIONS: OperationSpec[] = [
  {
    operationId: 'authOAuthCallback',
    method: 'get',
    path: '/auth/callback/{provider}',
    authz: {
      actor: 'public',
      rule: 'redirect target of the GitHub App; state and PKCE are checked by Better Auth',
    },
    schemas: {},
  },
];

/** Registers what the HTTP process needs from this module: the `admin` actor and extra operations. */
@Injectable()
export class AuthOperations implements OnModuleInit {
  constructor(
    @Inject(AuthService) private readonly auth: AuthService,
    /** The registry and the policies exist in the HTTP process only; the worker has no routes. */
    @Optional() @Inject(AuthzRegistry) private readonly registry?: AuthzRegistry,
    @Optional() @Inject(ActorPolicies) private readonly policies?: ActorPolicies,
  ) {}

  onModuleInit(): void {
    this.registry?.registerOperations(AUTH_EXTRA_OPERATIONS);
    if (this.policies !== undefined && this.policies.get('admin') === undefined) {
      this.policies.register('admin', adminPolicy(this.auth));
    }
  }
}
