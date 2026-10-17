import { Inject, Injectable } from '@nestjs/common';
import { and, asc, eq, isNotNull, lt } from 'drizzle-orm';
import { TxRunner } from '../../../../platform/tx/tx-runner.js';
import type { LinkStatus } from '../domain/link-policy.js';
import { checklistItem } from '../schema/stage.js';

export interface WaitingLink {
  id: string;
  teamId: string;
  linkUrl: string;
  version: number;
  updatedAt: Date;
}

/** Writes and reads of the link verdict on `workspace.checklist_item` (S5-09). */
@Injectable()
export class LinkCheckRepository {
  constructor(@Inject(TxRunner) private readonly tx: TxRunner) {}

  /**
   * Stores the verdict of a check. One conditional UPDATE: it applies only while the item still
   * carries this very link and still waits for an answer, so a late, repeated or stale answer changes
   * nothing. The version stays: the verdict is not an edit of the member (the open item PATCH of a
   * member must not lose to a background check). Returns the version, or `undefined` when ignored.
   */
  async settle(
    teamId: string,
    itemId: string,
    url: string,
    status: LinkStatus,
    now: Date,
  ): Promise<number | undefined> {
    const rows = await this.tx.tx
      .update(checklistItem)
      .set({ linkStatus: status, linkCheckedAt: now })
      .where(
        and(
          eq(checklistItem.id, itemId),
          eq(checklistItem.teamId, teamId),
          eq(checklistItem.linkUrl, url),
          eq(checklistItem.linkStatus, 'unchecked'),
        ),
      )
      .returning({ version: checklistItem.version });
    return rows[0]?.version;
  }

  /** Links saved before `before` that still wait for an answer, the oldest first (`checklist_item_link_unchecked_idx`). */
  async waitingSince(before: Date, limit: number): Promise<WaitingLink[]> {
    const rows = await this.tx.tx
      .select({
        id: checklistItem.id,
        teamId: checklistItem.teamId,
        linkUrl: checklistItem.linkUrl,
        version: checklistItem.version,
        updatedAt: checklistItem.updatedAt,
      })
      .from(checklistItem)
      .where(
        and(
          eq(checklistItem.linkStatus, 'unchecked'),
          isNotNull(checklistItem.linkUrl),
          lt(checklistItem.updatedAt, before),
        ),
      )
      .orderBy(asc(checklistItem.updatedAt))
      .limit(limit);
    return rows.flatMap((r) => (r.linkUrl === null ? [] : [{ ...r, linkUrl: r.linkUrl }]));
  }
}
