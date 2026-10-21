import { Inject, Injectable } from '@nestjs/common';
import { eq } from 'drizzle-orm';
import type { Database } from '../../../../platform/db/db.module.js';
import { TxRunner } from '../../../../platform/tx/tx-runner.js';
import { DomainError } from '../../../../platform/errors/domain-error.js';
import { ConsentService } from '../consent/consent.service.js';
import { user } from '../schema/auth.js';

export interface MeDto {
  id: string;
  displayName: string | null;
  emailMasked: string | null;
  status: 'active' | 'deleting';
  github: {
    linked: boolean;
    githubUserId: number | null;
    login: string | null;
    accountAgeOk: boolean | null;
  };
  consentRequired: boolean;
  consentVersion: string | null;
  isAdmin: boolean;
  locale: 'ru';
}

/** `alice@mail.ru` -> `a***@mail.ru`: enough to recognise the address, not to reuse it. */
export function maskEmail(email: string | null): string | null {
  if (email === null) return null;
  const at = email.lastIndexOf('@');
  if (at < 1) return null;
  return `${email.slice(0, 1)}***${email.slice(at)}`;
}

export type GithubAccountDto = MeDto['github'];

/** The current user as the client sees it (getMe). */
@Injectable()
export class MeService {
  constructor(
    @Inject(TxRunner) private readonly tx: TxRunner,
    @Inject(ConsentService) private readonly consent: ConsentService,
  ) {}

  /**
   * The client of the active transaction, else the pool. A read made inside a transaction must use
   * the transaction's connection: taking a second one from the pool starves it (architecture 12.1).
   */
  private get db(): Database {
    return this.tx.tx;
  }

  async getGithubAccount(userId: string): Promise<GithubAccountDto> {
    const rows = await this.db
      .select({ id: user.githubUserId, login: user.githubLogin })
      .from(user)
      .where(eq(user.id, userId));
    const row = rows[0];
    return {
      linked: row?.id != null,
      githubUserId: row?.id ?? null,
      login: row?.login ?? null,
      accountAgeOk: null,
    };
  }

  async getMe(userId: string): Promise<MeDto> {
    const rows = await this.db.select().from(user).where(eq(user.id, userId));
    const row = rows[0];
    if (row === undefined || row.status === 'deleted') {
      throw new DomainError('UNAUTHENTICATED', 401);
    }
    const consentVersion = await this.consent.validVersion(userId);
    return {
      id: row.id,
      displayName: row.name,
      emailMasked: maskEmail(row.email),
      status: row.status === 'deleting' ? 'deleting' : 'active',
      github: {
        linked: row.githubUserId !== null,
        githubUserId: row.githubUserId,
        login: row.githubLogin,
        accountAgeOk: null,
      },
      consentRequired: consentVersion === null,
      consentVersion,
      isAdmin: row.isAdmin,
      locale: 'ru',
    };
  }
}
