import { createHash, randomUUID } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import { eq } from 'drizzle-orm';
import { ClsService } from 'nestjs-cls';
import { Clock } from '../../../../platform/clock/clock.js';
import { APP_CONFIG } from '../../../../platform/config/config.module.js';
import type { AppConfig } from '../../../../platform/config/config.js';
import { DomainError } from '../../../../platform/errors/domain-error.js';
import { OutboxService } from '../../../../platform/outbox/outbox.service.js';
import { isLoopbackClient, RateLimiter } from '../../../../platform/ratelimit/rate-limiter.js';
import { LockService } from '../../../../platform/tx/locks.js';
import { TxRunner } from '../../../../platform/tx/tx-runner.js';
import { AUTH_MODULE } from '../../public.js';
import { user } from '../schema/auth.js';
import { cancelTokenFor, DELETION_REQUEST_CREATED_TYPE } from './deletion-notice.js';
import { DeletionRepository, type DeletionDto, toDeletionDto } from './deletion.repository.js';

const HOUR_MS = 3_600_000;
/** SEC-17: the request is executed 72 hours after it was made. */
export const GRACE_MS = 72 * HOUR_MS;
/** C-36: the data is gone within 30 days. */
export const DEADLINE_MS = 30 * 24 * HOUR_MS;
/** Better Auth `freshAge`: a session older than this must sign in again for requestDeletion. */
const FRESH_MS = 10 * 60_000;

export type DeletionReason = 'user_request' | 'consent_revoked';

const sha256 = (value: string): Buffer => createHash('sha256').update(value).digest();

/** Account deletion on request and its cancellation (FR-AUTH-09, SEC-17). */
@Injectable()
export class DeletionRequestService {
  constructor(
    @Inject(DeletionRepository) private readonly repository: DeletionRepository,
    @Inject(TxRunner) private readonly tx: TxRunner,
    @Inject(LockService) private readonly locks: LockService,
    @Inject(Clock) private readonly clock: Clock,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    @Inject(RateLimiter) private readonly limiter: RateLimiter,
    @Inject(OutboxService) private readonly outbox: OutboxService,
    @Inject(ClsService) private readonly cls: ClsService,
  ) {}

  /** The session must have been created less than 10 minutes ago (by wall time: it is the library's). */
  private assertFreshSession(): void {
    const createdAt = this.cls.get('sessionCreatedAt');
    if (createdAt !== undefined && Date.now() - createdAt > FRESH_MS) {
      throw new DomainError('REAUTH_REQUIRED', 403);
    }
  }

  /**
   * Marks the account `deleting` under lock #1, records the request and writes the outbox event
   * `auth.deletion_request_created` in the same transaction (S2CR-02). The mail with the cancel link
   * and the revocation of all sessions are done by the consumers of that event, with retries, so a
   * failure of Redis or SMTP after the commit cannot lose them. Only a hash of the token is stored;
   * the token itself is derived from the request id (`cancelTokenFor`).
   */
  async request(userId: string, reason: DeletionReason): Promise<DeletionDto> {
    this.assertFreshSession();
    const row = await this.tx.run(async () => {
      const locked = await this.locks.lockUser<{ status: string }>(userId);
      if (locked === undefined) throw new DomainError('NOT_FOUND', 404);
      if (locked.status !== 'active' || (await this.repository.openOf(userId)) !== undefined) {
        throw new DomainError('DELETION_ALREADY_REQUESTED', 409);
      }
      const now = this.clock.now();
      const id = randomUUID();
      const created = await this.repository.insert({
        id,
        userId,
        reason,
        status: 'requested',
        requestedAt: now,
        scheduledAt: new Date(now.getTime() + GRACE_MS),
        deadlineAt: new Date(now.getTime() + DEADLINE_MS),
        cancelTokenHash: sha256(cancelTokenFor(this.config.IP_HASH_SALT, id)),
      });
      await this.tx.tx
        .update(user)
        .set({ status: 'deleting', updatedAt: now })
        .where(eq(user.id, userId));
      await this.outbox.publish({
        module: AUTH_MODULE,
        type: DELETION_REQUEST_CREATED_TYPE,
        aggregateId: userId,
        payload: { requestId: id, userId },
      });
      return created;
    });
    return toDeletionDto(row);
  }

  /**
   * Cancels by the one-time token from the mail. Idempotent per token: a cancelled request answers
   * 200 again; a token that is unknown, or whose saga has started, is gone (410).
   */
  async cancel(ip: string, token: string): Promise<DeletionDto> {
    if (!isLoopbackClient(ip)) {
      await this.limiter.enforce('deletionCancel', this.limiter.ipSubject(ip));
    }
    return this.tx.run(async () => {
      // Lock order (architecture 12.1): the user (#1) before the deletion_request row.
      const hash = sha256(token);
      const ownerId = await this.repository.userIdByCancelHash(hash);
      if (ownerId === undefined) throw new DomainError('DELETION_CANCEL_GONE', 410);
      await this.locks.lockUser(ownerId);
      const found = await this.repository.lockByCancelHash(hash);
      if (found === undefined) throw new DomainError('DELETION_CANCEL_GONE', 410);
      if (found.status === 'cancelled') return toDeletionDto(found);
      const now = this.clock.now();
      if (found.status !== 'requested' || found.scheduledAt <= now) {
        throw new DomainError('DELETION_CANCEL_GONE', 410);
      }
      await this.tx.tx
        .update(user)
        .set({ status: 'active', updatedAt: now })
        .where(eq(user.id, found.userId));
      return toDeletionDto(await this.repository.markCancelled(found.id, now));
    });
  }
}
