import { Inject, Injectable } from '@nestjs/common';
import { and, asc, eq, gt, ilike, like, or, sql, type SQL } from 'drizzle-orm';
import { DB, type Database } from '../../../../platform/db/db.module.js';
import { registerConstraint } from '../../../../platform/errors/constraints.js';
import { TxRunner } from '../../../../platform/tx/tx-runner.js';
import { role, stackTag } from '../schema/profiles.js';

// A duplicate code is a 409 (the primary key of the catalog tables).
registerConstraint('role_pkey', { code: 'INVALID_STATE', status: 409 });
registerConstraint('stack_tag_pkey', { code: 'INVALID_STATE', status: 409 });

export interface CatalogEntry {
  code: string;
  name: string;
  active: boolean;
}

export type CatalogKind = 'role' | 'stackTag';

const entryColumns = (table: typeof role | typeof stackTag) => ({
  code: table.code,
  name: table.name,
  active: table.active,
});

export interface StackTagQuery {
  includeInactive: boolean;
  prefix?: string | undefined;
  after?: string | undefined;
  limit: number;
}

/** Escapes LIKE wildcards so that user input is matched literally. */
export function escapeLike(value: string): string {
  return value.replaceAll(/[\\%_]/g, (char) => `\\${char}`);
}

function prefixMatch(prefix: string): SQL {
  const pattern = `${escapeLike(prefix.toLowerCase())}%`;
  return or(like(stackTag.code, pattern), ilike(stackTag.name, pattern)) as SQL;
}

/** SQL of the two catalogs (profiles.role, profiles.stack_tag). Writes join the active transaction. */
@Injectable()
export class CatalogRepository {
  constructor(
    @Inject(DB) private readonly db: Database,
    @Inject(TxRunner) private readonly tx: TxRunner,
  ) {}

  listRoles(includeInactive: boolean): Promise<CatalogEntry[]> {
    return this.db
      .select(entryColumns(role))
      .from(role)
      .where(includeInactive ? undefined : eq(role.active, true))
      .orderBy(asc(role.ordinal), asc(role.code));
  }

  /** Keyset page by code; the extra row (limit + 1) tells the caller that more follows. */
  listStackTags(query: StackTagQuery): Promise<CatalogEntry[]> {
    const conditions: (SQL | undefined)[] = [
      query.includeInactive ? undefined : eq(stackTag.active, true),
      query.after === undefined ? undefined : gt(stackTag.code, query.after),
      query.prefix === undefined ? undefined : prefixMatch(query.prefix),
    ];
    return this.db
      .select(entryColumns(stackTag))
      .from(stackTag)
      .where(and(...conditions))
      .orderBy(asc(stackTag.code))
      .limit(query.limit + 1);
  }

  async insert(kind: CatalogKind, entry: { code: string; name: string }): Promise<CatalogEntry> {
    if (kind === 'role') {
      const rows = await this.tx.tx
        .insert(role)
        .values({
          ...entry,
          ordinal: sql`(SELECT coalesce(max(${role.ordinal}), 0) + 1 FROM ${role})`,
        })
        .returning(entryColumns(role));
      return rows[0] as CatalogEntry;
    }
    const rows = await this.tx.tx.insert(stackTag).values(entry).returning(entryColumns(stackTag));
    return rows[0] as CatalogEntry;
  }

  async update(
    kind: CatalogKind,
    code: string,
    patch: { name?: string; active?: boolean },
  ): Promise<CatalogEntry | undefined> {
    const table = kind === 'role' ? role : stackTag;
    if (patch.name === undefined && patch.active === undefined) {
      const rows = await this.tx.tx
        .select(entryColumns(table))
        .from(table)
        .where(eq(table.code, code));
      return rows[0];
    }
    const rows = await this.tx.tx
      .update(table)
      .set(patch)
      .where(eq(table.code, code))
      .returning(entryColumns(table));
    return rows[0];
  }
}
