import { Inject, Injectable } from '@nestjs/common';
import { and, desc, eq, inArray, isNull, lt, or, type SQL } from 'drizzle-orm';
import { TxRunner } from '../../../../platform/tx/tx-runner.js';
import { notification } from '../schema/notification.js';

export type NotificationRow = typeof notification.$inferSelect;

export interface NotificationCursor {
  at: Date;
  id: string;
}

/** `workspace.notification`: every query is bound to one user (x-authz `self`). */
@Injectable()
export class NotificationRepository {
  constructor(@Inject(TxRunner) private readonly tx: TxRunner) {}

  /** Inserts the rows that are new for their user; returns the created ones. */
  async insertNew(
    rows: (typeof notification.$inferInsert)[],
  ): Promise<{ id: string; userId: string; dedupeKey: string }[]> {
    if (rows.length === 0) return [];
    return this.tx.tx
      .insert(notification)
      .values(rows)
      .onConflictDoNothing({ target: [notification.userId, notification.dedupeKey] })
      .returning({
        id: notification.id,
        userId: notification.userId,
        dedupeKey: notification.dedupeKey,
      });
  }

  async listForUser(
    userId: string,
    unreadOnly: boolean,
    after: NotificationCursor | undefined,
    limit: number,
  ): Promise<NotificationRow[]> {
    const conditions: (SQL | undefined)[] = [
      eq(notification.userId, userId),
      unreadOnly ? isNull(notification.readAt) : undefined,
      after === undefined
        ? undefined
        : or(
            lt(notification.createdAt, after.at),
            and(eq(notification.createdAt, after.at), lt(notification.id, after.id)),
          ),
    ];
    return this.tx.tx
      .select()
      .from(notification)
      .where(and(...conditions))
      .orderBy(desc(notification.createdAt), desc(notification.id))
      .limit(limit);
  }

  /** Marks the caller's own unread rows; ids of other users simply do not match. */
  async markRead(userId: string, ids: string[], at: Date): Promise<void> {
    await this.tx.tx
      .update(notification)
      .set({ readAt: at })
      .where(
        and(
          eq(notification.userId, userId),
          inArray(notification.id, ids),
          isNull(notification.readAt),
        ),
      );
  }
}
