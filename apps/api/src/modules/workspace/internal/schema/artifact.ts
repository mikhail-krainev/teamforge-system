import { sql } from 'drizzle-orm';
import {
  bigint,
  boolean,
  check,
  index,
  integer,
  primaryKey,
  smallint,
  text,
  uuid,
} from 'drizzle-orm/pg-core';
import { bytea, tstz } from '../../../../platform/db/schema/columns.js';
import { workspaceSchema } from '../../../../platform/db/schema/module-schemas.js';
import { checklistItem } from './stage.js';

/** File attached to a checklist item (architecture 5.7); the object lives in MinIO under `storage_key`. */
export const artifactFile = workspaceSchema.table(
  'artifact_file',
  {
    id: uuid('id').primaryKey(),
    teamId: uuid('team_id').notNull(),
    checklistItemId: uuid('checklist_item_id')
      .notNull()
      .references(() => checklistItem.id),
    storageKey: text('storage_key').notNull().unique(),
    sha256: bytea('sha256').notNull(),
    sizeBytes: integer('size_bytes').notNull(),
    mime: text('mime').notNull(),
    originalName: text('original_name').notNull(),
    uploadedBy: uuid('uploaded_by').notNull(),
    createdAt: tstz('created_at').notNull(),
    deletedAt: tstz('deleted_at'),
  },
  (t) => [
    check('artifact_file_size_check', sql`${t.sizeBytes} >= 1024`),
    index('artifact_file_item_idx')
      .on(t.checklistItemId)
      .where(sql`${t.deletedAt} IS NULL`),
    index('artifact_file_sha_idx')
      .on(t.sha256)
      .where(sql`${t.deletedAt} IS NULL`),
  ],
);

/** Project quotas C-48, C-49: changed by a conditional UPDATE, the checks are the last guard. */
export const projectStorageUsage = workspaceSchema.table(
  'project_storage_usage',
  {
    teamId: uuid('team_id').primaryKey(),
    filesCount: integer('files_count').notNull().default(0),
    bytesTotal: bigint('bytes_total', { mode: 'number' }).notNull().default(0),
  },
  (t) => [
    check('project_storage_usage_files_check', sql`${t.filesCount} BETWEEN 0 AND 30`),
    check('project_storage_usage_bytes_check', sql`${t.bytesTotal} BETWEEN 0 AND 52428800`),
  ],
);

/** Last answer of the reviewer to a review point of the item (Р-3: points belong to the step). */
export const reviewAnswer = workspaceSchema.table(
  'review_answer',
  {
    checklistItemId: uuid('checklist_item_id')
      .notNull()
      .references(() => checklistItem.id),
    ordinal: smallint('ordinal').notNull(),
    reviewerUserId: uuid('reviewer_user_id').notNull(),
    answer: boolean('answer').notNull(),
    answeredAt: tstz('answered_at').notNull(),
  },
  (t) => [primaryKey({ columns: [t.checklistItemId, t.ordinal] })],
);

/** A risk accepted by the lead for a review point answered "no". */
export const reviewRisk = workspaceSchema.table(
  'review_risk',
  {
    checklistItemId: uuid('checklist_item_id')
      .notNull()
      .references(() => checklistItem.id),
    ordinal: smallint('ordinal').notNull(),
    reason: text('reason').notNull(),
    acceptedBy: uuid('accepted_by').notNull(),
    acceptedAt: tstz('accepted_at').notNull(),
  },
  (t) => [primaryKey({ columns: [t.checklistItemId, t.ordinal] })],
);
