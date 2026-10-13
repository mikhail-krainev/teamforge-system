import { Inject, Injectable } from '@nestjs/common';
import { and, asc, desc, eq } from 'drizzle-orm';
import { DB, type Database } from '../../../../platform/db/db.module.js';
import type {
  PlaybooksApi,
  ProductTypeCode,
  ProductTypeView,
  PublishedPlaybookRef,
} from '../../public.js';
import { playbook, productType } from '../schema/playbooks.js';

/** Read-only facade of the playbooks module (`PlaybooksApi`). */
@Injectable()
export class PlaybooksFacade implements PlaybooksApi {
  constructor(@Inject(DB) private readonly db: Database) {}

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
    const filtered = options.activeOnly === true ? query.where(eq(productType.active, true)) : query;
    return filtered.orderBy(asc(productType.code));
  }
}
