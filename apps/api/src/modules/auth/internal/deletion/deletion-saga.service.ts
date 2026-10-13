import { randomUUID } from 'node:crypto';
import { Inject, Injectable, type OnModuleInit } from '@nestjs/common';
import { eq, sql } from 'drizzle-orm';
import type { Redis } from 'ioredis';
import { Clock } from '../../../../platform/clock/clock.js';
import { APP_CONFIG } from '../../../../platform/config/config.module.js';
import type { AppConfig } from '../../../../platform/config/config.js';
import { hmacBytes } from '../../../../platform/crypto/secret-box.js';
import { OutboxService } from '../../../../platform/outbox/outbox.service.js';
import { MaintenanceTasks } from '../../../../platform/queues/maintenance-tasks.js';
import { RATE_LIMITS, RateLimiter } from '../../../../platform/ratelimit/rate-limiter.js';
import { REDIS } from '../../../../platform/redis/redis.module.js';
import { LockService } from '../../../../platform/tx/locks.js';
import { TxRunner } from '../../../../platform/tx/tx-runner.js';
import { AUTH_MODULE, type DeletionModule } from '../../public.js';
import { normalizeEmail } from '../magic-link/email-normalizer.js';
import {
  account,
  consent,
  identitySignal,
  identityTombstone,
  user,
  verification,
} from '../schema/auth.js';
import { SessionRevoker } from '../services/session-revoker.js';
import { DeletionRepository } from './deletion.repository.js';

const SCHEDULER_EVERY_MS = 5 * 60_000;
const BATCH = 50;
const TOMBSTONE_MS = 180 * 24 * 3_600_000;

/**
 * Modules whose step must be reported before auth erases the account itself (architecture 13.9).
 * Slice 2 knows `profiles` only; teams, matching, workspace, github and rewards add themselves in
 * their slices (and subscribe to the same event).
 */
export const EXPECTED_DELETION_MODULES: readonly DeletionModule[] = ['profiles'];

interface UserSnapshot {
  email: string | null;
  email_normalized: string | null;
  github_user_id: string | null;
}

/** `LIKE` pattern that matches the text literally. */
const literal = (value: string): string => `%${value.replaceAll(/[\\%_]/g, (c) => `\\${c}`)}%`;

/** The saga that erases an account: scheduler, module steps, final step of auth. */
@Injectable()
export class DeletionSagaService implements OnModuleInit {
  constructor(
    @Inject(DeletionRepository) private readonly repository: DeletionRepository,
    @Inject(TxRunner) private readonly tx: TxRunner,
    @Inject(LockService) private readonly locks: LockService,
    @Inject(OutboxService) private readonly outbox: OutboxService,
    @Inject(Clock) private readonly clock: Clock,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    @Inject(MaintenanceTasks) private readonly maintenance: MaintenanceTasks,
    @Inject(RateLimiter) private readonly limiter: RateLimiter,
    @Inject(SessionRevoker) private readonly sessions: SessionRevoker,
    @Inject(REDIS) private readonly redis: Redis,
  ) {}

  onModuleInit(): void {
    this.maintenance.register({
      name: 'deletion-scheduler',
      everyMs: SCHEDULER_EVERY_MS,
      run: () => this.startDue(),
    });
  }

  /** Step 1: requests whose 72 hours are over start their saga; safe to run twice (nothing is due then). */
  startDue(): Promise<number> {
    return this.tx.run(async () => {
      const due = await this.repository.dueRequests(this.clock.now(), BATCH);
      for (const request of due) {
        await this.repository.start(request.id);
        await this.outbox.publish({
          module: AUTH_MODULE,
          type: 'user_deletion_requested',
          aggregateId: request.userId,
          payload: { requestId: request.id, userId: request.userId, reason: request.reason },
        });
      }
      return due.length;
    });
  }

  /** Step 2 bookkeeping: a module reports; the last expected one triggers the step of auth. */
  async reportStep(
    requestId: string,
    module: DeletionModule,
    counts: Record<string, number>,
  ): Promise<void> {
    await this.tx.run(async () => {
      const now = this.clock.now();
      if (!(await this.repository.addStep(requestId, module, now))) return;
      await this.repository.log(
        { id: randomUUID(), requestId, module, action: 'erase' },
        counts,
        now,
      );
      const reported = new Set(await this.repository.reportedModules(requestId));
      if (EXPECTED_DELETION_MODULES.every((expected) => reported.has(expected))) {
        await this.finalize(requestId);
      }
    });
  }

  /** Step 3: tombstones, erasure of the identity, completion (architecture 13.9). */
  private async finalize(requestId: string): Promise<void> {
    const request = await this.repository.findById(requestId);
    if (request === undefined) return;
    const locked = await this.locks.lockUser<UserSnapshot & Record<string, unknown>>(
      request.userId,
    );
    if (locked === undefined) return;
    const now = this.clock.now();
    const counts = await this.erase(request.userId, locked, now);
    if (!(await this.repository.complete(requestId, now))) return;
    await this.repository.log(
      { id: randomUUID(), requestId, module: AUTH_MODULE, action: 'anonymize' },
      counts,
      now,
    );
    await this.outbox.publish({
      module: AUTH_MODULE,
      type: 'user_deleted',
      aggregateId: request.userId,
      payload: { userId: request.userId },
    });
    await this.sessions.revokeUserSessions(request.userId);
    await this.dropRateKeys(request.userId, locked.email_normalized);
  }

  private async erase(
    userId: string,
    snapshot: UserSnapshot,
    now: Date,
  ): Promise<Record<string, number>> {
    const db = this.tx.tx;
    await this.writeTombstones(snapshot, now);
    const signals = await db
      .delete(identitySignal)
      .where(eq(identitySignal.userId, userId))
      .returning({ k: identitySignal.kind });
    const accounts = await db
      .delete(account)
      .where(eq(account.userId, userId))
      .returning({ id: account.id });
    const pending = snapshot.email
      ? await db
          .delete(verification)
          .where(sql`${verification.value} ILIKE ${literal(snapshot.email)}`)
          .returning({ id: verification.id })
      : [];
    await db.update(consent).set({ ipHash: null }).where(eq(consent.userId, userId));
    const keys = await db.execute(
      sql`DELETE FROM platform.idempotency_key WHERE user_id = ${userId}::uuid RETURNING 1`,
    );
    await db
      .update(user)
      .set({
        email: null,
        emailNormalized: null,
        name: null,
        image: null,
        githubUserId: null,
        githubLogin: null,
        status: 'deleted',
        updatedAt: now,
      })
      .where(eq(user.id, userId));
    return {
      identity_signals: signals.length,
      accounts: accounts.length,
      verifications: pending.length,
      idempotency_keys: keys.length,
    };
  }

  /** SEC-13: HMACs only, so that deleting an account does not hide a repeat registration (AF-15). */
  private async writeTombstones(snapshot: UserSnapshot, now: Date): Promise<void> {
    const salt = this.config.IP_HASH_SALT;
    const values: { kind: string; valueHmac: Buffer }[] = [];
    if (snapshot.github_user_id !== null) {
      values.push({
        kind: 'github_user_id',
        valueHmac: hmacBytes(salt, String(snapshot.github_user_id)),
      });
    }
    if (snapshot.email_normalized !== null) {
      values.push({
        kind: 'email_normalized',
        valueHmac: hmacBytes(salt, snapshot.email_normalized),
      });
    }
    if (values.length === 0) return;
    const expiresAt = new Date(now.getTime() + TOMBSTONE_MS);
    await this.tx.tx
      .insert(identityTombstone)
      .values(values.map((value) => ({ ...value, deletedAt: now, expiresAt })))
      .onConflictDoUpdate({
        target: [identityTombstone.kind, identityTombstone.valueHmac],
        set: { deletedAt: now, expiresAt },
      });
  }

  /** Rate-limit keys that name the user or the HMAC of the address are removed (SEC-11). */
  private async dropRateKeys(userId: string, emailNormalized: string | null): Promise<void> {
    const keys = Object.keys(RATE_LIMITS).map(
      (category) => `rl:${category}:${this.limiter.userSubject(userId)}`,
    );
    if (emailNormalized !== null) {
      keys.push(`rl:authLinkEmail:${this.limiter.emailSubject(emailNormalized)}`);
      keys.push(`rl:authLinkEmail:${this.limiter.emailSubject(normalizeEmail(emailNormalized))}`);
    }
    await this.redis.del(...keys);
  }
}
