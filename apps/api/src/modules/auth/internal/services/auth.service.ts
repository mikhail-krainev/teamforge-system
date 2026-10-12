import { Inject, Injectable } from '@nestjs/common';
import { and, eq, gte, inArray, isNotNull } from 'drizzle-orm';
import { DB, type Database } from '../../../../platform/db/db.module.js';
import { DomainError } from '../../../../platform/errors/domain-error.js';
import { LockService } from '../../../../platform/tx/locks.js';
import type {
  AuthApi,
  IdentitySignal,
  JoinEligibility,
  UserId,
  UserIdentity,
} from '../../public.js';
import { ConsentService } from '../consent/consent.service.js';
import { identitySignal, user } from '../schema/auth.js';

type UserStatus = JoinEligibility['status'];

/** Implementation of the auth facade (`AuthApi`). */
@Injectable()
export class AuthService implements AuthApi {
  constructor(
    @Inject(DB) private readonly db: Database,
    @Inject(LockService) private readonly locks: LockService,
    @Inject(ConsentService) private readonly consent: ConsentService,
  ) {}

  async lockUserForJoin(userId: UserId): Promise<JoinEligibility> {
    const row = await this.locks.lockUser<{
      id: string;
      status: UserStatus;
      github_user_id: string | null;
    }>(userId);
    if (row === undefined) throw new DomainError('NOT_FOUND', 404);
    if (row.status !== 'active') throw new DomainError('USER_INACTIVE', 409);
    return {
      userId,
      status: row.status,
      // bigint columns come back from the raw query as strings.
      githubUserId: row.github_user_id === null ? null : Number(row.github_user_id),
      consentValid: await this.consent.hasValidConsent(userId),
    };
  }

  async getIdentity(userId: UserId): Promise<UserIdentity | null> {
    const rows = await this.db
      .select({
        githubUserId: user.githubUserId,
        githubLogin: user.githubLogin,
        status: user.status,
      })
      .from(user)
      .where(eq(user.id, userId));
    return rows[0] ?? null;
  }

  async findUserIdsByGithubIds(githubUserIds: number[]): Promise<Map<number, UserId>> {
    if (githubUserIds.length === 0) return new Map();
    const rows = await this.db
      .select({ id: user.id, githubUserId: user.githubUserId })
      .from(user)
      .where(and(inArray(user.githubUserId, githubUserIds), isNotNull(user.githubUserId)));
    return new Map(rows.flatMap((r) => (r.githubUserId === null ? [] : [[r.githubUserId, r.id]])));
  }

  async isAdmin(userId: UserId): Promise<boolean> {
    const rows = await this.db
      .select({ isAdmin: user.isAdmin, status: user.status })
      .from(user)
      .where(eq(user.id, userId));
    return rows[0]?.isAdmin === true && rows[0].status === 'active';
  }

  hasValidConsent(userId: UserId): Promise<boolean> {
    return this.consent.hasValidConsent(userId);
  }

  async getIdentitySignals(userIds: UserId[], since: Date): Promise<IdentitySignal[]> {
    if (userIds.length === 0) return [];
    const rows = await this.db
      .select()
      .from(identitySignal)
      .where(and(inArray(identitySignal.userId, userIds), gte(identitySignal.lastSeen, since)));
    return rows.map((r) => ({
      userId: r.userId,
      kind: r.kind as IdentitySignal['kind'],
      valueHmac: r.valueHmac.toString('hex'),
    }));
  }
}
