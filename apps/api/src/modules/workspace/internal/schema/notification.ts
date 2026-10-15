import { index, jsonb, text, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import { tstz } from '../../../../platform/db/schema/columns.js';
import { workspaceSchema } from '../../../../platform/db/schema/module-schemas.js';

/** In-app notification (architecture 13.13). The payload holds ids and codes only (SEC-11). */
export const notification = workspaceSchema.table(
  'notification',
  {
    id: uuid('id').primaryKey(),
    userId: uuid('user_id').notNull(),
    type: text('type').notNull(),
    payload: jsonb('payload').notNull(),
    dedupeKey: text('dedupe_key').notNull(),
    createdAt: tstz('created_at').notNull(),
    readAt: tstz('read_at'),
  },
  (t) => [
    uniqueIndex('notification_dedupe_uq').on(t.userId, t.dedupeKey),
    index('notification_user_idx').on(t.userId, t.createdAt.desc(), t.id.desc()),
  ],
);
