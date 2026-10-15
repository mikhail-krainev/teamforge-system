import { sql } from 'drizzle-orm';
import { boolean, check, index, integer, text, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import { bytea, tstz } from '../../../../platform/db/schema/columns.js';
import { playbooksSchema } from '../../../../platform/db/schema/module-schemas.js';

/** Minimum of the playbooks module for slice 3 (architecture 5.4); stages and steps arrive in slice 5. */
export const productType = playbooksSchema.table('product_type', {
  code: text('code').primaryKey(),
  name: text('name').notNull(),
  active: boolean('active').notNull().default(false),
});

export const playbook = playbooksSchema.table(
  'playbook',
  {
    id: uuid('id').primaryKey(),
    productTypeCode: text('product_type_code')
      .notNull()
      .references(() => productType.code),
    title: text('title').notNull(),
    version: text('version').notNull(),
    vMajor: integer('v_major').notNull(),
    vMinor: integer('v_minor').notNull(),
    vPatch: integer('v_patch').notNull(),
    status: text('status').notNull(),
    totalDays: integer('total_days').notNull(),
    sourceText: text('source_text').notNull(),
    sourceSha256: bytea('source_sha256').notNull(),
    /** auth.user, no FK across modules. */
    uploadedBy: uuid('uploaded_by').notNull(),
    publishedAt: tstz('published_at'),
  },
  (t) => [
    check('playbook_status_check', sql`${t.status} IN ('draft','published')`),
    check('playbook_total_days_check', sql`${t.totalDays} > 0`),
    uniqueIndex('playbook_type_version_uq').on(t.productTypeCode, t.version),
    index('playbook_latest_idx')
      .on(t.productTypeCode, t.vMajor.desc(), t.vMinor.desc(), t.vPatch.desc())
      .where(sql`${t.status} = 'published'`),
  ],
);
