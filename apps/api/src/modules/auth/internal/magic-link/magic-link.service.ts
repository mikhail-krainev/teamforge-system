import { createHash } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import { isAPIError } from 'better-auth/api';
import { eq } from 'drizzle-orm';
import type { FastifyRequest } from 'fastify';
import type { Database } from '../../../../platform/db/db.module.js';
import { TxRunner } from '../../../../platform/tx/tx-runner.js';
import { DomainError } from '../../../../platform/errors/domain-error.js';
import { findPgError, PG_UNIQUE_VIOLATION } from '../../../../platform/errors/pg-errors.js';
import { RateLimiter } from '../../../../platform/ratelimit/rate-limiter.js';
import type { Auth } from '../better-auth/create-auth.js';
import { AUTH } from '../better-auth/tokens.js';
import { toWebHeaders } from '../better-auth/web-bridge.js';
import { user, verification } from '../schema/auth.js';
import { isDisposableDomain } from './disposable-domains.js';
import { emailDomain, normalizeEmail } from './email-normalizer.js';

export interface VerifyResult {
  redirectTo: string;
  /** `Set-Cookie` lines produced by Better Auth. */
  cookies: string[];
}

/** SHA-256, base64url without padding: how the plugin stores a token (`storeToken: 'hashed'`). */
function storedIdentifier(token: string): string {
  return `magic-link:${createHash('sha256').update(token).digest('base64url')}`;
}

function refused(code: string, message: string): DomainError {
  return new DomainError('VALIDATION_FAILED', 422, {
    errors: [{ pointer: '/email', code, message }],
  });
}

/** Sign-in by e-mail link (FR-AUTH-02, FR-AUTH-04, FR-AUTH-06). */
@Injectable()
export class MagicLinkService {
  constructor(
    @Inject(AUTH) private readonly auth: Auth,
    @Inject(TxRunner) private readonly tx: TxRunner,
    @Inject(RateLimiter) private readonly limiter: RateLimiter,
  ) {}

  /**
   * The client of the active transaction, else the pool. A read made inside a transaction must use
   * the transaction's connection: taking a second one from the pool starves it (architecture 12.1).
   */
  private get db(): Database {
    return this.tx.tx;
  }

  /** Checks and limits first, then lets the library store the token and call `queueMail`. */
  async request(request: FastifyRequest, email: string): Promise<{ status: true }> {
    const normalized = normalizeEmail(email);
    await this.limiter.enforce('authLinkIp', this.limiter.ipSubject(request.ip));
    await this.limiter.enforce('authLinkEmail', this.limiter.emailSubject(normalized));
    if (isDisposableDomain(emailDomain(email))) {
      throw refused('disposable_domain', 'Disposable e-mail domains are not accepted');
    }
    // The answer never depends on whether the mailbox is registered (S2SEC-02).
    const target = await this.registeredSpelling(email, normalized);
    await this.auth.api.signInMagicLink({
      body: { email: target },
      headers: toWebHeaders(request),
    });
    return { status: true };
  }

  /**
   * The same mailbox under another spelling is an existing account, not a new one. The link goes to
   * the address stored with the account (the same single mail and the same `{status: true}` as for
   * any other request), so the response gives no hint that the account exists (S2SEC-02).
   */
  private async registeredSpelling(email: string, normalized: string): Promise<string> {
    const rows = await this.db
      .select({ email: user.email })
      .from(user)
      .where(eq(user.emailNormalized, normalized))
      .limit(1);
    return rows[0]?.email ?? email;
  }

  /** Exchanges the token for a session. One use only: concurrent calls race inside the library. */
  async verify(
    request: FastifyRequest,
    token: string,
    callbackURL?: string,
  ): Promise<VerifyResult> {
    await this.assertUsable(token);
    try {
      const result = await this.auth.api.magicLinkVerify({
        query: { token },
        headers: toWebHeaders(request),
        returnHeaders: true,
      });
      return { redirectTo: callbackURL ?? '/', cookies: result.headers.getSetCookie() };
    } catch (error) {
      // The library answers a lost race or a rejected token with a redirect to its error page (an
      // API error). A second link of a new address confirmed at the same moment loses the race to
      // create the user (unique violation); its token is spent, like the first link's twin.
      // Anything else is a real failure and must not look like a bad token.
      const lostRace = findPgError(error)?.code === PG_UNIQUE_VIOLATION;
      if (isAPIError(error) || lostRace) throw new DomainError('INVALID_TOKEN', 401);
      throw error;
    }
  }

  /** Expiry is judged by wall time: Better Auth stamps `expires_at` with it (not with the app Clock). */
  private async assertUsable(token: string): Promise<void> {
    const rows = await this.db
      .select({ expiresAt: verification.expiresAt })
      .from(verification)
      .where(eq(verification.identifier, storedIdentifier(token)))
      .limit(1);
    const row = rows[0];
    if (row === undefined) throw new DomainError('INVALID_TOKEN', 401);
    if (row.expiresAt.getTime() <= Date.now()) {
      throw new DomainError('EXPIRED_TOKEN', 401);
    }
  }
}
