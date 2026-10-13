import { Inject, Injectable } from '@nestjs/common';
import type { Auth } from '../better-auth/create-auth.js';
import { AUTH } from '../better-auth/tokens.js';

/** Revokes every session of a user (deletion of personal data, FR-AUTH-07, FR-AUTH-09). */
@Injectable()
export class SessionRevoker {
  constructor(@Inject(AUTH) private readonly auth: Auth) {}

  /** Removes the user's sessions and the per-user session list from Redis. */
  async revokeUserSessions(userId: string): Promise<void> {
    const context = await this.auth.$context;
    await context.internalAdapter.deleteUserSessions(userId);
  }
}
