import { createHmac, randomUUID } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import { and, desc, eq, isNull, sql } from 'drizzle-orm';
import { Clock } from '../../../../platform/clock/clock.js';
import { APP_CONFIG } from '../../../../platform/config/config.module.js';
import type { AppConfig } from '../../../../platform/config/config.js';
import { DB, type Database } from '../../../../platform/db/db.module.js';
import { DomainError } from '../../../../platform/errors/domain-error.js';
import { LockService } from '../../../../platform/tx/locks.js';
import { TxRunner } from '../../../../platform/tx/tx-runner.js';
import { consent } from '../schema/auth.js';
import { type ConsentText, loadCurrentConsentText } from './consent-text.js';

export interface ConsentRecord {
  version: string;
  acceptedAt: string;
}

/** Consent text and its acceptance (FR-AUTH-03). */
@Injectable()
export class ConsentService {
  private readonly current: ConsentText = loadCurrentConsentText();

  constructor(
    @Inject(DB) private readonly db: Database,
    @Inject(TxRunner) private readonly tx: TxRunner,
    @Inject(LockService) private readonly locks: LockService,
    @Inject(Clock) private readonly clock: Clock,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  currentText(): ConsentText {
    return this.current;
  }

  private validFor(userId: string) {
    return and(
      eq(consent.userId, userId),
      eq(consent.version, this.current.version),
      eq(consent.textHash, Buffer.from(this.current.textHash, 'hex')),
      isNull(consent.revokedAt),
    );
  }

  /** True when a non-revoked consent of the current version and text hash exists. */
  async hasValidConsent(userId: string): Promise<boolean> {
    const rows = await this.db
      .select({ one: sql<number>`1` })
      .from(consent)
      .where(this.validFor(userId))
      .limit(1);
    return rows.length > 0;
  }

  /** Version of the newest valid consent, or null. */
  async validVersion(userId: string): Promise<string | null> {
    const rows = await this.db
      .select({ version: consent.version })
      .from(consent)
      .where(this.validFor(userId))
      .orderBy(desc(consent.acceptedAt))
      .limit(1);
    return rows[0]?.version ?? null;
  }

  /**
   * Records the acceptance of the current text. Version and hash must match it (422). The user
   * row is locked first (lock #1), so parallel calls produce one record per version.
   */
  accept(
    userId: string,
    input: { version: string; textHash: string },
    ip: string,
  ): Promise<ConsentRecord> {
    if (input.version !== this.current.version || input.textHash !== this.current.textHash) {
      throw new DomainError('VALIDATION_FAILED', 422, {
        errors: [
          { pointer: '/version', code: 'outdated', message: 'Not the current consent text' },
        ],
      });
    }
    return this.tx.run(async () => {
      await this.locks.lockUser(userId);
      const existing = await this.tx.tx
        .select({ version: consent.version, acceptedAt: consent.acceptedAt })
        .from(consent)
        .where(this.validFor(userId))
        .limit(1);
      const found = existing[0];
      if (found !== undefined) {
        return { version: found.version, acceptedAt: found.acceptedAt.toISOString() };
      }
      const acceptedAt = this.clock.now();
      await this.tx.tx.insert(consent).values({
        id: randomUUID(),
        userId,
        version: this.current.version,
        textHash: Buffer.from(this.current.textHash, 'hex'),
        acceptedAt,
        ipHash: createHmac('sha256', this.config.IP_HASH_SALT).update(ip).digest(),
      });
      return { version: this.current.version, acceptedAt: acceptedAt.toISOString() };
    });
  }
}
