import { Inject, Injectable } from '@nestjs/common';
import type { FastifyRequest } from 'fastify';
import type { SessionAuthenticator } from '../../src/platform/authz/actor-policies.js';
import type { AppConfig } from '../../src/platform/config/config.js';
import { APP_CONFIG } from '../../src/platform/config/config.module.js';

/**
 * Test-only stand-in for the session: the user id comes from `X-Test-User`. It lives in `test/`, is
 * imported only by the test bootstrap (never by `AppModule`, never part of the build) and ignores
 * the header unless the configuration says `NODE_ENV=test` (S1R-08).
 */
@Injectable()
export class TestSessionAuthenticator implements SessionAuthenticator {
  constructor(@Inject(APP_CONFIG) private readonly config: AppConfig) {}

  authenticate(request: FastifyRequest): string | undefined {
    if (this.config.NODE_ENV !== 'test') return undefined;
    const header = request.headers['x-test-user'];
    const userId = Array.isArray(header) ? header[0] : header;
    return userId === undefined || userId === '' ? undefined : userId;
  }
}
