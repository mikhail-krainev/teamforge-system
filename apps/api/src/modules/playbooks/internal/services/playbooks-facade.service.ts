import { Inject, Injectable } from '@nestjs/common';
import { and, asc, desc, eq, inArray } from 'drizzle-orm';
import type { Database } from '../../../../platform/db/db.module.js';
import { TxRunner } from '../../../../platform/tx/tx-runner.js';
import type {
  PlaybookDefinition,
  PlaybookId,
  PlaybooksApi,
  ProductTypeCode,
  ProductTypeView,
  PublishedPlaybookRef,
} from '../../public.js';
import { PlaybookDefinitions } from '../read/playbook-definitions.js';
import { playbook, productType } from '../schema/playbooks.js';

/** Read-only facade of the playbooks module (`PlaybooksApi`). */
@Injectable()
export class PlaybooksFacade implements PlaybooksApi {
  constructor(
    @Inject(TxRunner) private readonly tx: TxRunner,
    @Inject(PlaybookDefinitions) private readonly definitions: PlaybookDefinitions,
  ) {}

  /**
   * The client of the active transaction, else the pool. A read made inside a transaction must use
   * the transaction's connection: taking a second one from the pool starves it (architecture 12.1).
   */
  private get db(): Database {
    return this.tx.tx;
  }

  getDefinition(id: PlaybookId): Promise<PlaybookDefinition> {
    return this.definitions.get(id);
  }

  async isActiveProductType(code: ProductTypeCode): Promise<boolean> {
    const rows = await this.db
      .select({ active: productType.active })
      .from(productType)
      .where(eq(productType.code, code));
    return rows[0]?.active === true;
  }

  async getLatestPublished(code: ProductTypeCode): Promise<PublishedPlaybookRef | null> {
    // Served by playbook_latest_idx: the highest published semver first.
    const rows = await this.db
      .select({ id: playbook.id, version: playbook.version, totalDays: playbook.totalDays })
      .from(playbook)
      .where(and(eq(playbook.productTypeCode, code), eq(playbook.status, 'published')))
      .orderBy(desc(playbook.vMajor), desc(playbook.vMinor), desc(playbook.vPatch))
      .limit(1);
    return rows[0] ?? null;
  }

  async listProductTypes(options: { activeOnly?: boolean } = {}): Promise<ProductTypeView[]> {
    const query = this.db
      .select({ code: productType.code, name: productType.name, active: productType.active })
      .from(productType);
    const filtered =
      options.activeOnly === true ? query.where(eq(productType.active, true)) : query;
    return filtered.orderBy(asc(productType.code));
  }

  async getVersions(ids: PlaybookId[]): Promise<Map<PlaybookId, string>> {
    if (ids.length === 0) return new Map();
    const rows = await this.db
      .select({ id: playbook.id, version: playbook.version })
      .from(playbook)
      .where(inArray(playbook.id, [...new Set(ids)]));
    return new Map(rows.map((row) => [row.id, row.version]));
  }
}
