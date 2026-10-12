import { Inject, Injectable } from '@nestjs/common';
import {
  buildPage,
  clampLimit,
  decodeCursor,
  type Page,
} from '../../../../platform/db/pagination.js';
import { DomainError } from '../../../../platform/errors/domain-error.js';
import { TxRunner } from '../../../../platform/tx/tx-runner.js';
import { CatalogRepository, type CatalogEntry, type CatalogKind } from './catalog.repository.js';

export interface StackTagListInput {
  includeInactive?: boolean | undefined;
  prefix?: string | undefined;
  cursor?: string | undefined;
  limit?: number | undefined;
}

/** Catalogs of roles and stack tags (FR-PROF-09): lists for signed-in users, writes for admins. */
@Injectable()
export class CatalogService {
  constructor(
    @Inject(CatalogRepository) private readonly repository: CatalogRepository,
    @Inject(TxRunner) private readonly tx: TxRunner,
  ) {}

  async listRoles(includeInactive = false): Promise<{ items: CatalogEntry[] }> {
    return { items: await this.repository.listRoles(includeInactive) };
  }

  async listStackTags(input: StackTagListInput): Promise<Page<CatalogEntry>> {
    const includeInactive = input.includeInactive ?? false;
    const filters = { includeInactive, prefix: input.prefix ?? null };
    const limit = clampLimit(input.limit);
    const after =
      input.cursor === undefined ? undefined : String(decodeCursor(input.cursor, filters).k[0]);
    const rows = await this.repository.listStackTags({
      includeInactive,
      prefix: input.prefix,
      after,
      limit,
    });
    return buildPage(rows, limit, (row) => [row.code], filters);
  }

  create(kind: CatalogKind, entry: { code: string; name: string }): Promise<CatalogEntry> {
    return this.tx.run(() => this.repository.insert(kind, entry));
  }

  update(
    kind: CatalogKind,
    code: string,
    patch: { name?: string; active?: boolean },
  ): Promise<CatalogEntry> {
    return this.tx.run(async () => {
      const updated = await this.repository.update(kind, code, patch);
      if (updated === undefined) throw new DomainError('NOT_FOUND', 404);
      return updated;
    });
  }
}
