import { Global, Module } from '@nestjs/common';
import { APP_GUARD, DiscoveryModule } from '@nestjs/core';
import { ActorPolicies } from './actor-policies.js';
import { AuthzGuard } from './authz.guard.js';
import { AuthzRegistry, CONTRACT_DOCUMENT } from './authz.registry.js';
import { loadContractDocument } from './contract-operations.js';
import { ValidationGuard } from './validation.guard.js';

/**
 * HTTP authorization and validation (architecture 13.3, 13.14). Guards are global and run in this
 * order: AuthzGuard (deny by default), then ValidationGuard. Only the HTTP process imports it.
 */
@Global()
@Module({
  imports: [DiscoveryModule],
  providers: [
    { provide: CONTRACT_DOCUMENT, useFactory: loadContractDocument },
    ActorPolicies,
    AuthzRegistry,
    { provide: APP_GUARD, useClass: AuthzGuard },
    { provide: APP_GUARD, useClass: ValidationGuard },
  ],
  exports: [AuthzRegistry, ActorPolicies],
})
export class AuthzModule {}
