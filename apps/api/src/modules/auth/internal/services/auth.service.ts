import { Inject, Injectable } from '@nestjs/common';
import { ClsService } from 'nestjs-cls';
import { and, eq, gt, gte, inArray, isNotNull, or } from 'drizzle-orm';
import { APP_CONFIG } from '../../../../platform/config/config.module.js';
import type { AppConfig } from '../../../../platform/config/config.js';
import { hmacBytes } from '../../../../platform/crypto/secret-box.js';
import type { Database } from '../../../../platform/db/db.module.js';
import { DomainError } from '../../../../platform/errors/domain-error.js';
import { LockService } from '../../../../platform/tx/locks.js';
import { TxRunner } from '../../../../platform/tx/tx-runner.js';
import type {
  AccountFacts,
  AuthApi,
  DeletionModule,
  IdentitySignal,
  JoinEligibility,
  UserId,
  UserIdentity,
} from '../../public.js';
import { normalizeEmail } from '../magic-link/email-normalizer.js';
import { ConsentService } from '../consent/consent.service.js';
import { DeletionSagaService } from '../deletion/deletion-saga.service.js';
import { identitySignal, identityTombstone, user } from '../schema/auth.js';

type UserStatus = JoinEligibility['status'];

/** Implementation of the auth facade (`AuthApi`). */
@Injectable()
export class AuthService implements AuthApi {
  constructor(
    @Inject(TxRunner) private readonly tx: TxRunner,
    @Inject(LockService) private readonly locks: LockService,
    @Inject(ConsentService) private readonly consent: ConsentService,
    @Inject(DeletionSagaService) private readonly saga: DeletionSagaService,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    @Inject(ClsService) private readonly cls: ClsService,
  ) {}

  /**
   * The client of the active transaction, else the pool. A read made inside a transaction must use
   * the transaction's connection: taking a second one from the pool starves it (architecture 12.1).
   */
  private get db(): Database {
    return this.tx.tx;
  }

  async lockUserForJoin(userId: UserId): Promise<JoinEligibility> {
    const row = await this.locks.lockUser<{
      id: string;
      status: UserStatus;
      github_user_id: string | null;
    }>(userId);
    if (row === undefined) throw new DomainError('NOT_FOUND', 404);
    if (row.status !== 'active') throw new DomainError('USER_INACTIVE', 409);
    const eligibility: JoinEligibility = {
      userId,
      status: row.status,
      // bigint columns come back from the raw query as strings.
      githubUserId: row.github_user_id === null ? null : Number(row.github_user_id),
      consentValid: await this.consent.hasValidConsent(userId),
    };
    this.rememberLock(eligibility);
    return eligibility;
  }

  /** Lets `TeamsApi.joinSeat({ userLocked: true })` verify lock #1 and reuse what was read under it. */
  private rememberLock(eligibility: JoinEligibility): void {
    if (!this.cls.isActive()) return;
    const locked = this.cls.get('lockedUsers') ?? {};
    locked[eligibility.userId] = {
      githubUserId: eligibility.githubUserId,
      consentValid: eligibility.consentValid,
    };
    this.cls.set('lockedUsers', locked);
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

  hmacOfEmail(email: string): Buffer {
    return hmacBytes(this.config.IP_HASH_SALT, normalizeEmail(email));
  }

  async getEmailHmac(userId: UserId): Promise<Buffer | null> {
    const rows = await this.db
      .select({ email: user.emailNormalized })
      .from(user)
      .where(eq(user.id, userId));
    const email = rows[0]?.email;
    return email === undefined || email === null
      ? null
      : hmacBytes(this.config.IP_HASH_SALT, email);
  }

  async getMailRecipient(userId: UserId): Promise<string | null> {
    const rows = await this.db
      .select({ email: user.email, status: user.status })
      .from(user)
      .where(eq(user.id, userId));
    const row = rows[0];
    if (row === undefined || row.status !== 'active' || !row.email) return null;
    return (await this.consent.hasValidConsent(userId)) ? row.email : null;
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

  async filterMatchable(userIds: UserId[]): Promise<Set<UserId>> {
    if (userIds.length === 0) return new Set();
    const active = await this.db
      .select({ id: user.id })
      .from(user)
      .where(and(inArray(user.id, userIds), eq(user.status, 'active')));
    return this.consent.usersWithValidConsent(active.map((row) => row.id));
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

  reportDeletionStep(
    requestId: string,
    module: DeletionModule,
    counts: Record<string, number>,
  ): Promise<void> {
    return this.saga.reportStep(requestId, module, counts);
  }

  async matchesTombstone(userId: UserId): Promise<boolean> {
    const rows = await this.db
      .select({ github: user.githubUserId, email: user.emailNormalized })
      .from(user)
      .where(eq(user.id, userId));
    const row = rows[0];
    if (row === undefined) return false;
    const salt = this.config.IP_HASH_SALT;
    const candidates = [
      row.github === null ? null : { kind: 'github_user_id', value: String(row.github) },
      row.email === null ? null : { kind: 'email_normalized', value: row.email },
    ].flatMap((candidate) => (candidate === null ? [] : [candidate]));
    for (const candidate of candidates) {
      const found = await this.db
        .select({ kind: identityTombstone.kind })
        .from(identityTombstone)
        .where(
          and(
            eq(identityTombstone.kind, candidate.kind),
            eq(identityTombstone.valueHmac, hmacBytes(salt, candidate.value)),
            gt(identityTombstone.expiresAt, new Date()),
          ),
        )
        .limit(1);
      if (found.length > 0) return true;
    }
    return false;
  }

  async getAccountFacts(userIds: UserId[]): Promise<Map<UserId, AccountFacts>> {
    if (userIds.length === 0) return new Map();
    const rows = await this.db
      .select({
        id: user.id,
        github: user.githubUserId,
        email: user.emailNormalized,
        createdAt: user.createdAt,
      })
      .from(user)
      .where(inArray(user.id, userIds));
    const hashes = await this.tombstonedHmacs(rows);
    const salt = this.config.IP_HASH_SALT;
    const matched = (kind: string, value: string | null): boolean =>
      value !== null && hashes.has(`${kind}:${hmacBytes(salt, value).toString('hex')}`);
    return new Map(
      rows.map((row) => [
        row.id,
        {
          userId: row.id,
          githubUserId: row.github,
          registeredAt: row.createdAt,
          tombstoneMatch:
            matched('github_user_id', row.github === null ? null : String(row.github)) ||
            matched('email_normalized', row.email),
        },
      ]),
    );
  }

  /** The `kind:hex` of every tombstone that matches one of the accounts, in one statement. */
  private async tombstonedHmacs(
    rows: { github: number | null; email: string | null }[],
  ): Promise<Set<string>> {
    const salt = this.config.IP_HASH_SALT;
    const candidates = rows.flatMap((row) => [
      ...(row.github === null
        ? []
        : [
            and(
              eq(identityTombstone.kind, 'github_user_id'),
              eq(identityTombstone.valueHmac, hmacBytes(salt, String(row.github))),
            ),
          ]),
      ...(row.email === null
        ? []
        : [
            and(
              eq(identityTombstone.kind, 'email_normalized'),
              eq(identityTombstone.valueHmac, hmacBytes(salt, row.email)),
            ),
          ]),
    ]);
    if (candidates.length === 0) return new Set();
    const found = await this.db
      .select({ kind: identityTombstone.kind, hmac: identityTombstone.valueHmac })
      .from(identityTombstone)
      .where(and(or(...candidates), gt(identityTombstone.expiresAt, new Date())));
    return new Set(found.map((f) => `${f.kind}:${f.hmac.toString('hex')}`));
  }
}
