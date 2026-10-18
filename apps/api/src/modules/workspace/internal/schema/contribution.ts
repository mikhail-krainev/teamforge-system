import { sql } from 'drizzle-orm';
import { boolean, check, index, smallint, text, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import { tstz } from '../../../../platform/db/schema/columns.js';
import { workspaceSchema } from '../../../../platform/db/schema/module-schemas.js';

/**
 * A piece of work credited to a member (architecture 5.7, FR-GH-05, FR-WORK-16, -17). The unique
 * index makes every source idempotent: a repeated webhook, the daily reconciliation and a reopened
 * issue all end on the same row (CC-11).
 */
export const contribution = workspaceSchema.table(
  'contribution',
  {
    id: uuid('id').primaryKey(),
    teamId: uuid('team_id').notNull(),
    userId: uuid('user_id').notNull(),
    source: text('source').notNull(),
    /** `issue:<repoId>#<n>`, `pr:<repoId>#<n>` or `item:<itemId>`. */
    ref: text('ref').notNull(),
    title: text('title').notNull(),
    url: text('url'),
    roleCode: text('role_code').notNull(),
    /** Set when the project is completed: the roles of the snapshot no longer change. */
    roleLocked: boolean('role_locked').notNull().default(false),
    /** The stage that was open at `received_at`. */
    stageOrdinal: smallint('stage_ordinal'),
    /** False: the issue was reopened or the checklist item went back to `open`. */
    active: boolean('active').notNull().default(true),
    occurredAt: tstz('occurred_at').notNull(),
    receivedAt: tstz('received_at').notNull(),
  },
  (t) => [
    check('contribution_source_check', sql`${t.source} IN ('issue','pr','artifact','ritual')`),
    uniqueIndex('contribution_uq').on(t.teamId, t.source, t.ref, t.userId),
    index('contribution_stage_user_idx').on(t.teamId, t.stageOrdinal, t.userId),
    index('contribution_feed_idx').on(t.teamId, t.receivedAt.desc(), t.id.desc()),
  ],
);
