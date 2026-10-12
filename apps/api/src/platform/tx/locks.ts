import { Inject, Injectable } from '@nestjs/common';
import { TransactionHost } from '@nestjs-cls/transactional';
import { sql, type SQL } from 'drizzle-orm';
import { ClsService } from 'nestjs-cls';
import { APP_CONFIG } from '../config/config.module.js';
import type { AppConfig } from '../config/config.js';
import { InvariantError } from '../errors/domain-error.js';
import { assertAttemptAlive } from './attempt.js';
import type { TxHost } from './tx-runner.js';

export type LockMode = 'FOR UPDATE' | 'FOR NO KEY UPDATE' | 'FOR SHARE';

export interface LockTarget {
  /** Position in the global order of architecture 12.1. */
  level: number;
  schema: string;
  table: string;
  mode: LockMode;
}

/** Global lock order (architecture 12.1). A transaction may skip levels, never go back. */
export const LOCK_TARGETS = {
  user: { level: 1, schema: 'auth', table: 'user', mode: 'FOR NO KEY UPDATE' },
  searchApplication: {
    level: 2,
    schema: 'matching',
    table: 'search_application',
    mode: 'FOR UPDATE',
  },
  invitation: { level: 3, schema: 'teams', table: 'invitation', mode: 'FOR UPDATE' },
  seatOffer: { level: 3, schema: 'teams', table: 'seat_offer', mode: 'FOR UPDATE' },
  departure: { level: 3, schema: 'teams', table: 'departure', mode: 'FOR UPDATE' },
  team: { level: 4, schema: 'teams', table: 'team', mode: 'FOR NO KEY UPDATE' },
  seat: { level: 5, schema: 'teams', table: 'seat', mode: 'FOR UPDATE' },
  membership: { level: 6, schema: 'teams', table: 'membership', mode: 'FOR UPDATE' },
  seatAssignment: { level: 6, schema: 'teams', table: 'seat_assignment', mode: 'FOR UPDATE' },
  leaderVote: { level: 7, schema: 'teams', table: 'leader_vote', mode: 'FOR UPDATE' },
  projectStage: { level: 8, schema: 'workspace', table: 'project_stage', mode: 'FOR UPDATE' },
  repoLink: { level: 10, schema: 'github', table: 'repo_link', mode: 'FOR UPDATE' },
  creditRun: { level: 11, schema: 'rewards', table: 'credit_run', mode: 'FOR UPDATE' },
} as const satisfies Record<string, LockTarget>;

/** Level 9 (workspace.checklist_item) is never locked: it uses a conditional UPDATE by version. */
export const CHECKLIST_ITEM_LEVEL = 9;

export type Row = Record<string, unknown>;

/**
 * Typed row-lock helpers. Each helper locks rows by id (several ids ascending) and returns the
 * locked rows. In NODE_ENV=test, taking a lower level than one already taken throws.
 */
@Injectable()
export class LockService {
  private readonly enforceOrder: boolean;

  constructor(
    @Inject(TransactionHost) private readonly host: TxHost,
    @Inject(ClsService) private readonly cls: ClsService,
    @Inject(APP_CONFIG) config: AppConfig,
  ) {
    this.enforceOrder = config.NODE_ENV === 'test';
  }

  lockUser<T extends Row = Row>(id: string): Promise<T | undefined> {
    return this.lockOne<T>(LOCK_TARGETS.user, id);
  }

  lockSearchApplication<T extends Row = Row>(id: string): Promise<T | undefined> {
    return this.lockOne<T>(LOCK_TARGETS.searchApplication, id);
  }

  /** Level 3 "ticket": invitation, seat offer or departure. */
  lockTicket<T extends Row = Row>(
    kind: 'invitation' | 'seatOffer' | 'departure',
    id: string,
  ): Promise<T | undefined> {
    return this.lockOne<T>(LOCK_TARGETS[kind], id);
  }

  /** `share` is used by operations that only need to be serialized against the owner. */
  lockTeam<T extends Row = Row>(
    id: string,
    mode: 'update' | 'share' = 'update',
  ): Promise<T | undefined> {
    const lockMode: LockMode = mode === 'share' ? 'FOR SHARE' : 'FOR NO KEY UPDATE';
    return this.lockOne<T>({ ...LOCK_TARGETS.team, mode: lockMode }, id);
  }

  /** Several seats are always locked in ascending id order. */
  lockSeats<T extends Row = Row>(ids: string[]): Promise<T[]> {
    return this.lockMany<T>(LOCK_TARGETS.seat, ids);
  }

  lockMembership<T extends Row = Row>(id: string): Promise<T | undefined> {
    return this.lockOne<T>(LOCK_TARGETS.membership, id);
  }

  lockSeatAssignment<T extends Row = Row>(id: string): Promise<T | undefined> {
    return this.lockOne<T>(LOCK_TARGETS.seatAssignment, id);
  }

  lockLeaderVote<T extends Row = Row>(id: string): Promise<T | undefined> {
    return this.lockOne<T>(LOCK_TARGETS.leaderVote, id);
  }

  lockProjectStage<T extends Row = Row>(
    id: string,
    mode: 'update' | 'share' = 'update',
  ): Promise<T | undefined> {
    const lockMode: LockMode = mode === 'share' ? 'FOR SHARE' : 'FOR UPDATE';
    return this.lockOne<T>({ ...LOCK_TARGETS.projectStage, mode: lockMode }, id);
  }

  lockRepoLink<T extends Row = Row>(id: string): Promise<T | undefined> {
    return this.lockOne<T>(LOCK_TARGETS.repoLink, id);
  }

  lockCreditRun<T extends Row = Row>(id: string): Promise<T | undefined> {
    return this.lockOne<T>(LOCK_TARGETS.creditRun, id);
  }

  /** Generic entry used by the typed helpers. */
  async lockOne<T extends Row>(target: LockTarget, id: string): Promise<T | undefined> {
    const rows = await this.lockMany<T>(target, [id]);
    return rows[0];
  }

  async lockMany<T extends Row>(target: LockTarget, ids: string[]): Promise<T[]> {
    if (!this.host.isTransactionActive()) {
      throw new InvariantError(
        `Row lock on ${target.schema}.${target.table} outside a transaction`,
      );
    }
    assertAttemptAlive(this.cls);
    this.checkOrder(target);
    const sorted = [...new Set(ids)].sort();
    if (sorted.length === 0) return [];
    const idList = sql.join(
      sorted.map((id) => sql`${id}::uuid`),
      sql`, `,
    );
    const query: SQL = sql`SELECT * FROM ${sql.identifier(target.schema)}.${sql.identifier(target.table)}
      WHERE id IN (${idList}) ORDER BY id ${sql.raw(target.mode)}`;
    const rows = await this.host.tx.execute(query);
    return [...rows] as T[];
  }

  private checkOrder(target: LockTarget): void {
    const current = this.cls.get('lockLevel') ?? 0;
    if (this.enforceOrder && target.level < current) {
      throw new InvariantError(
        `Lock order violation: level ${target.level} (${target.table}) after level ${current}`,
      );
    }
    this.cls.set('lockLevel', Math.max(current, target.level));
  }
}
