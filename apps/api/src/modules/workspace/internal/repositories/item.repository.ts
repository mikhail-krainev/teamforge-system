import { Inject, Injectable } from '@nestjs/common';
import { and, eq, inArray, isNull, sql } from 'drizzle-orm';
import { TxRunner } from '../../../../platform/tx/tx-runner.js';
import { artifactFile } from '../schema/artifact.js';
import { checklistItem, projectStage } from '../schema/stage.js';
import type { ItemRow, StageRow } from './route.repository.js';

/** Columns a write may set; `version` and `updatedAt` are added by `updateIfVersion`. */
export type ItemChanges = Partial<
  Omit<typeof checklistItem.$inferInsert, 'id' | 'teamId' | 'projectStageId' | 'version'>
>;

/** Writes to `workspace.checklist_item` (architecture 5.7, lock level 9: a conditional UPDATE, never a row lock). */
@Injectable()
export class ItemRepository {
  constructor(@Inject(TxRunner) private readonly tx: TxRunner) {}

  /** The item of the team; an item of another team looks the same as a missing one. */
  async findItem(teamId: string, itemId: string): Promise<ItemRow | undefined> {
    const rows = await this.tx.tx
      .select()
      .from(checklistItem)
      .where(and(eq(checklistItem.id, itemId), eq(checklistItem.teamId, teamId)));
    return rows[0];
  }

  /**
   * The item with `FOR SHARE`: the reader sees the state that no writer can change until it commits.
   * Used by the consumer that mirrors the item in a contribution (a write of the item waits for it).
   */
  async findItemShared(teamId: string, itemId: string): Promise<ItemRow | undefined> {
    const rows = await this.tx.tx
      .select()
      .from(checklistItem)
      .where(and(eq(checklistItem.id, itemId), eq(checklistItem.teamId, teamId)))
      .for('share');
    return rows[0];
  }

  async findStage(teamId: string, stageId: string): Promise<StageRow | undefined> {
    const rows = await this.tx.tx
      .select()
      .from(projectStage)
      .where(and(eq(projectStage.id, stageId), eq(projectStage.teamId, teamId)));
    return rows[0];
  }

  async countFiles(itemId: string): Promise<number> {
    const rows = await this.tx.tx
      .select({ n: sql<number>`count(*)::int` })
      .from(artifactFile)
      .where(and(eq(artifactFile.checklistItemId, itemId), isNull(artifactFile.deletedAt)));
    return rows[0]?.n ?? 0;
  }

  /**
   * CC-7: `UPDATE ... SET version = version + 1 WHERE id = :id AND version = :v`. No row means the
   * version moved on; the caller reads the current item and answers 409.
   */
  async updateIfVersion(
    itemId: string,
    version: number,
    changes: ItemChanges,
    now: Date,
  ): Promise<ItemRow | undefined> {
    const rows = await this.tx.tx
      .update(checklistItem)
      .set({ ...changes, version: sql`${checklistItem.version} + 1`, updatedAt: now })
      .where(and(eq(checklistItem.id, itemId), eq(checklistItem.version, version)))
      .returning();
    return rows[0];
  }

  /** A write of the system (a departure), not of a client: no version to compare, the version still moves. */
  async update(itemId: string, changes: ItemChanges, now: Date): Promise<void> {
    await this.tx.tx
      .update(checklistItem)
      .set({ ...changes, version: sql`${checklistItem.version} + 1`, updatedAt: now })
      .where(eq(checklistItem.id, itemId));
  }

  /** Open items of the open stage: the ones a departure can leave without an executor. */
  openItemsOfOpenStage(teamId: string): Promise<ItemRow[]> {
    return this.tx.tx
      .select({ item: checklistItem })
      .from(checklistItem)
      .innerJoin(projectStage, eq(projectStage.id, checklistItem.projectStageId))
      .where(
        and(
          eq(checklistItem.teamId, teamId),
          eq(checklistItem.status, 'open'),
          eq(projectStage.status, 'open'),
        ),
      )
      .then((rows) => rows.map((r) => r.item));
  }

  /** Items that stayed without an executor when these users left (FR-TEAM-11, FR-TEAM-13). */
  async orphanedBy(teamId: string, userIds: string[]): Promise<{ id: string; userId: string }[]> {
    if (userIds.length === 0) return [];
    const rows = await this.tx.tx
      .select({ id: checklistItem.id, userId: checklistItem.unassignedFromUserId })
      .from(checklistItem)
      .where(
        and(
          eq(checklistItem.teamId, teamId),
          eq(checklistItem.status, 'open'),
          isNull(checklistItem.assigneeUserId),
          inArray(checklistItem.unassignedFromUserId, userIds),
        ),
      )
      .orderBy(checklistItem.stepKey);
    return rows.flatMap((r) => (r.userId === null ? [] : [{ id: r.id, userId: r.userId }]));
  }
}
