import { Inject, Injectable, Optional } from '@nestjs/common';
import type { ConsentGate } from '../../../../platform/authz/actor-policies.js';
import { AuthzRegistry } from '../../../../platform/authz/authz.registry.js';
import { DomainError } from '../../../../platform/errors/domain-error.js';
import { ConsentService } from './consent.service.js';

/** Operations of /v1 that work without consent (architecture 13.10). */
export const CONSENT_EXEMPT_OPERATIONS: ReadonlySet<string> = new Set([
  'getMe',
  'getCurrentConsentText',
  'acceptConsent',
  'requestDeletion',
  'cancelDeletionRequest',
]);

/**
 * ConsentGuard of architecture 13.10, run by AuthzGuard right after the actor policy (before the
 * request body is validated): a signed-in user who has not accepted the current consent text gets
 * 403 CONSENT_REQUIRED on every operation of `/v1` except the exemptions above. Operations
 * outside the contract (probes) and library routes are not checked.
 */
@Injectable()
export class ConsentGuard implements ConsentGate {
  constructor(
    @Inject(ConsentService) private readonly consent: ConsentService,
    /** Only the HTTP process has a registry (and requests to guard). */
    @Optional() @Inject(AuthzRegistry) private readonly registry?: AuthzRegistry,
  ) {}

  async check(operationId: string, userId: string): Promise<void> {
    if (this.registry === undefined || CONSENT_EXEMPT_OPERATIONS.has(operationId)) return;
    const spec = this.registry.get(operationId);
    if (spec === undefined || !this.registry.isContractOperation(operationId)) return;
    if (!spec.path.startsWith('/v1/')) return;
    if (!(await this.consent.hasValidConsent(userId))) {
      throw new DomainError('CONSENT_REQUIRED', 403);
    }
  }
}
