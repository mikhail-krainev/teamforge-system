import { Inject, Injectable } from '@nestjs/common';
import { OutboxService } from '../../../../platform/outbox/outbox.service.js';
import { TxRunner } from '../../../../platform/tx/tx-runner.js';
import { AUTH_MODULE } from '../../public.js';
import type { Auth } from '../better-auth/create-auth.js';
import { AUTH } from '../better-auth/tokens.js';

/** Outbox event type: a session (or all sessions) of a user ended. Read by the realtime gateway. */
export const SESSION_REVOKED = 'session_revoked';

export type SessionRevocationReason = 'sign_out' | 'revoke_all';

/** Revokes sessions and tells the rest of the system (FR-AUTH-07, FR-AUTH-09, S3SEC-01). */
@Injectable()
export class SessionRevoker {
  constructor(
    @Inject(AUTH) private readonly auth: Auth,
    @Inject(TxRunner) private readonly tx: TxRunner,
    @Inject(OutboxService) private readonly outbox: OutboxService,
  ) {}

  /**
   * Removes the user's sessions and the per-user session list from Redis, then writes
   * `auth.session_revoked` (joins the caller's transaction, e.g. the inbox transaction of a
   * consumer, or opens its own). Sessions live in Redis, so the event cannot share their
   * transaction; it is written after they are gone, and the gateway also re-checks sessions.
   */
  async revokeUserSessions(userId: string): Promise<void> {
    const context = await this.auth.$context;
    await context.internalAdapter.deleteUserSessions(userId);
    await this.announce(userId, null, 'revoke_all');
  }

  /** Sign-out of one session (already deleted by the library): tells the gateway to close its sockets. */
  async announceSignOut(userId: string, sessionId: string): Promise<void> {
    await this.announce(userId, sessionId, 'sign_out');
  }

  /** Ids only: the session token never leaves Redis and the cookie (SEC-07). */
  private announce(
    userId: string,
    sessionId: string | null,
    reason: SessionRevocationReason,
  ): Promise<void> {
    return this.tx.run(async () => {
      await this.outbox.publish({
        module: AUTH_MODULE,
        type: SESSION_REVOKED,
        aggregateId: userId,
        payload: { v: 1, userId, sessionId, reason },
      });
    });
  }
}
