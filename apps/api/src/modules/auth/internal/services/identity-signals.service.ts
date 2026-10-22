import { isIP } from 'node:net';
import { Inject, Injectable } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import { Clock } from '../../../../platform/clock/clock.js';
import { APP_CONFIG } from '../../../../platform/config/config.module.js';
import type { AppConfig } from '../../../../platform/config/config.js';
import { hmacBytes } from '../../../../platform/crypto/secret-box.js';
import type { Database } from '../../../../platform/db/db.module.js';
import { TxRunner } from '../../../../platform/tx/tx-runner.js';
import { identitySignal } from '../schema/auth.js';

/** IPv4 /24 and IPv6 /48 prefix of an address; `null` for anything that is not an IP. */
export function ipPrefix(ip: string): string | null {
  const version = isIP(ip);
  if (version === 4) return `${ip.split('.').slice(0, 3).join('.')}.0/24`;
  if (version === 6) {
    const groups = ip.includes('::') ? expandIpv6(ip) : ip.split(':');
    return `${groups.slice(0, 3).join(':')}::/48`;
  }
  return null;
}

function expandIpv6(ip: string): string[] {
  const [head = '', tail = ''] = ip.split('::');
  const left = head === '' ? [] : head.split(':');
  const right = tail === '' ? [] : tail.split(':');
  return [
    ...left,
    ...Array<string>(Math.max(0, 8 - left.length - right.length)).fill('0'),
    ...right,
  ];
}

/** Anti-fraud inputs written at sign-in (SEC-13): HMAC values only, no raw IP or User-Agent. */
@Injectable()
export class IdentitySignalsService {
  constructor(
    @Inject(TxRunner) private readonly tx: TxRunner,
    @Inject(Clock) private readonly clock: Clock,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  /**
   * The client of the active transaction, else the pool. A read made inside a transaction must use
   * the transaction's connection: taking a second one from the pool starves it (architecture 12.1).
   */
  private get db(): Database {
    return this.tx.tx;
  }

  /** Upserts `ip24` and `ua` signals of a sign-in (device cookie signals are written by the web layer). */
  async record(
    userId: string,
    ip: string | null | undefined,
    userAgent: string | null | undefined,
  ) {
    const values: { kind: 'ip24' | 'ua'; value: string }[] = [];
    const prefix = ip === null || ip === undefined ? null : ipPrefix(ip);
    if (prefix !== null) values.push({ kind: 'ip24', value: prefix });
    if (userAgent) values.push({ kind: 'ua', value: userAgent });
    if (values.length === 0) return;
    const now = this.clock.now();
    await this.db
      .insert(identitySignal)
      .values(
        values.map(({ kind, value }) => ({
          userId,
          kind,
          valueHmac: hmacBytes(this.config.IP_HASH_SALT, value),
          firstSeen: now,
          lastSeen: now,
        })),
      )
      .onConflictDoUpdate({
        target: [identitySignal.userId, identitySignal.kind, identitySignal.valueHmac],
        set: { lastSeen: sql`excluded.last_seen` },
      });
  }
}
