import { Inject, Injectable } from '@nestjs/common';
import { and, eq, inArray, isNull, lt, sql } from 'drizzle-orm';
import { TxRunner } from '../../../../platform/tx/tx-runner.js';
import { PROJECT_MAX_BYTES, PROJECT_MAX_FILES } from '../domain/artifact-file.js';
import { artifactFile, projectStorageUsage } from '../schema/artifact.js';
import { checklistItem } from '../schema/stage.js';
import type { FileRow } from './route.repository.js';

/**
 * Files of checklist items and the project quota (architecture 5.7, 12.3). The item is "locked" at
 * level 9 by a conditional UPDATE of its row; the quota is a conditional UPDATE of the usage row,
 * always taken after the item, so the two never wait for each other in a cycle.
 */
@Injectable()
export class ArtifactRepository {
  constructor(@Inject(TxRunner) private readonly tx: TxRunner) {}

  /**
   * `UPDATE checklist_item SET version = version + 1 WHERE id = :id AND status = 'open'`: the row
   * lock serializes uploads, deletions and `PATCH`; no row means the item was closed meanwhile.
   */
  async bumpOpenItem(itemId: string, now: Date): Promise<number | undefined> {
    const rows = await this.tx.tx
      .update(checklistItem)
      .set({ version: sql`${checklistItem.version} + 1`, updatedAt: now })
      .where(and(eq(checklistItem.id, itemId), eq(checklistItem.status, 'open')))
      .returning({ version: checklistItem.version });
    return rows[0]?.version;
  }

  /** C-48, C-49: false when 30 files or 50 MiB would be exceeded. */
  async reserveQuota(teamId: string, size: number): Promise<boolean> {
    await this.tx.tx.insert(projectStorageUsage).values({ teamId }).onConflictDoNothing();
    const rows = await this.tx.tx
      .update(projectStorageUsage)
      .set({
        filesCount: sql`${projectStorageUsage.filesCount} + 1`,
        bytesTotal: sql`${projectStorageUsage.bytesTotal} + ${size}`,
      })
      .where(
        and(
          eq(projectStorageUsage.teamId, teamId),
          lt(projectStorageUsage.filesCount, PROJECT_MAX_FILES),
          sql`${projectStorageUsage.bytesTotal} + ${size} <= ${PROJECT_MAX_BYTES}`,
        ),
      )
      .returning({ teamId: projectStorageUsage.teamId });
    return rows.length > 0;
  }

  /** The reverse UPDATE of a deletion (the checks keep the counters from going below zero). */
  async releaseQuota(teamId: string, size: number): Promise<void> {
    await this.tx.tx
      .update(projectStorageUsage)
      .set({
        filesCount: sql`${projectStorageUsage.filesCount} - 1`,
        bytesTotal: sql`${projectStorageUsage.bytesTotal} - ${size}`,
      })
      .where(eq(projectStorageUsage.teamId, teamId));
  }

  async insert(row: typeof artifactFile.$inferInsert): Promise<FileRow> {
    const rows = await this.tx.tx.insert(artifactFile).values(row).returning();
    const created = rows[0];
    if (created === undefined) throw new Error('artifact_file insert returned no row');
    return created;
  }

  /** The whole chain in one query (architecture 13.14): a file of another team or item looks missing. */
  async find(teamId: string, itemId: string, fileId: string): Promise<FileRow | undefined> {
    const rows = await this.tx.tx
      .select()
      .from(artifactFile)
      .where(
        and(
          eq(artifactFile.id, fileId),
          eq(artifactFile.checklistItemId, itemId),
          eq(artifactFile.teamId, teamId),
          isNull(artifactFile.deletedAt),
        ),
      );
    return rows[0];
  }

  /** Marks the file deleted; no row when somebody else deleted it first. */
  async markDeleted(fileId: string, now: Date): Promise<FileRow | undefined> {
    const rows = await this.tx.tx
      .update(artifactFile)
      .set({ deletedAt: now })
      .where(and(eq(artifactFile.id, fileId), isNull(artifactFile.deletedAt)))
      .returning();
    return rows[0];
  }

  /** Keys that a live row still points to: the rest are orphans of the bucket (deleted files are removed by event). */
  async referencedKeys(keys: string[]): Promise<Set<string>> {
    if (keys.length === 0) return new Set();
    const rows = await this.tx.tx
      .select({ key: artifactFile.storageKey })
      .from(artifactFile)
      .where(and(inArray(artifactFile.storageKey, keys), isNull(artifactFile.deletedAt)));
    return new Set(rows.map((r) => r.key));
  }
}
