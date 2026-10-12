import { describe, expect, it } from 'vitest';
import type { AuthzRegistry } from '../../../../platform/authz/authz.registry.js';
import { ConsentGuard } from './consent.gate.js';
import type { ConsentService } from './consent.service.js';

function build(options: { consent: boolean; contract?: boolean; path?: string }) {
  const registry = {
    get: () => ({ path: options.path ?? '/v1/teams' }),
    isContractOperation: () => options.contract ?? true,
  } as unknown as AuthzRegistry;
  const consent = { hasValidConsent: async () => options.consent } as unknown as ConsentService;
  return new ConsentGuard(consent, registry);
}

describe('ConsentGuard', () => {
  it('refuses a signed-in user without valid consent with 403 CONSENT_REQUIRED', async () => {
    await expect(build({ consent: false }).check('listTeams', 'u1')).rejects.toMatchObject({
      code: 'CONSENT_REQUIRED',
      status: 403,
    });
  });

  it('lets a user with valid consent through', async () => {
    await expect(build({ consent: true }).check('listTeams', 'u1')).resolves.toBeUndefined();
  });

  it.each([
    'getMe',
    'getCurrentConsentText',
    'acceptConsent',
    'requestDeletion',
    'cancelDeletionRequest',
  ])('exempts %s', async (operationId) => {
    await expect(build({ consent: false }).check(operationId, 'u1')).resolves.toBeUndefined();
  });

  it('does not check library routes or operations outside the contract', async () => {
    const library = build({ consent: false, path: '/auth/sign-out' });
    await expect(library.check('signOut', 'u1')).resolves.toBeUndefined();
    const probe = build({ consent: false, contract: false });
    await expect(probe.check('testEcho', 'u1')).resolves.toBeUndefined();
  });
});
