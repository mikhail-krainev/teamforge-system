import { Inject, Injectable, Optional } from '@nestjs/common';
import type { FastifyRequest } from 'fastify';
import type { SessionAuthenticator } from '../../src/platform/authz/actor-policies.js';
import type { AppConfig } from '../../src/platform/config/config.js';
import { APP_CONFIG } from '../../src/platform/config/config.module.js';
import { BetterAuthSessionAuthenticator } from '../../src/modules/auth/internal/services/session.authenticator.js';

/**
 * Test-only stand-in for the session: the user id comes from `X-Test-User`. It lives in `test/`, is
 * imported only by the test bootstrap (never by `AppModule`, never part of the build) and ignores
 * the header unless the configuration says `NODE_ENV=test` (S1R-08). Without the header it falls back
 * to the real session cookie.
 */
@Injectable()
export class TestSessionAuthenticator implements SessionAuthenticator {
  constructor(
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    @Optional()
    @Inject(BetterAuthSessionAuthenticator)
    private readonly real?: BetterAuthSessionAuthenticator,
  ) {}

  authenticate(request: FastifyRequest): Promise<string | undefined> | string | undefined {
    if (this.config.NODE_ENV === 'test') {
      const header = request.headers['x-test-user'];
      const userId = Array.isArray(header) ? header[0] : header;
      if (userId !== undefined && userId !== '') return userId;
    }
    // No header: a real Better Auth session cookie (slice 2 tests sign in for real).
    return this.real?.authenticate(request);
  }
}
