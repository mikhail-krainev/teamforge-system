import { sql } from 'drizzle-orm';
import {
  boolean,
  check,
  index,
  integer,
  primaryKey,
  smallint,
  text,
  unique,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { bytea, tstz } from '../../../../platform/db/schema/columns.js';
import { playbooksSchema } from '../../../../platform/db/schema/module-schemas.js';

/** Tables of the playbooks module (architecture 5.4). */
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

export const stage = playbooksSchema.table(
  'stage',
  {
    id: uuid('id').primaryKey(),
    playbookId: uuid('playbook_id')
      .notNull()
      .references(() => playbook.id),
    key: text('key').notNull(),
    ordinal: smallint('ordinal').notNull(),
    title: text('title').notNull(),
    goal: text('goal').notNull(),
    durationDays: integer('duration_days').notNull(),
    exitCriteria: text('exit_criteria').notNull(),
  },
  (t) => [
    check('stage_duration_days_check', sql`${t.durationDays} > 0`),
    unique('stage_playbook_ordinal_uq').on(t.playbookId, t.ordinal),
    unique('stage_playbook_key_uq').on(t.playbookId, t.key),
  ],
);

export const step = playbooksSchema.table(
  'step',
  {
    id: uuid('id').primaryKey(),
    playbookId: uuid('playbook_id')
      .notNull()
      .references(() => playbook.id),
    stageId: uuid('stage_id')
      .notNull()
      .references(() => stage.id),
    key: text('key').notNull(),
    ordinal: smallint('ordinal').notNull(),
    title: text('title').notNull(),
    description: text('description').notNull(),
    kind: text('kind').notNull(),
    submission: text('submission'),
    ritualKind: text('ritual_kind'),
    required: boolean('required').notNull(),
    /** A role code or `any`. */
    ownerRole: text('owner_role').notNull(),
    altRoles: text('alt_roles')
      .array()
      .notNull()
      .default(sql`'{}'::text[]`),
    reviewChecklist: boolean('review_checklist').notNull(),
    autoChecks: text('auto_checks')
      .array()
      .notNull()
      .default(sql`'{}'::text[]`),
    sources: text('sources').array().notNull(),
  },
  (t) => [
    check('step_kind_check', sql`${t.kind} IN ('artifact','ritual')`),
    check('step_submission_check', sql`${t.submission} IN ('link','file','either')`),
    check(
      'step_ritual_kind_check',
      sql`${t.ritualKind} IN ('call','retro','brainstorm','code_review')`,
    ),
    check(
      'step_kind_submission_check',
      sql`(${t.kind} = 'artifact') = (${t.submission} IS NOT NULL)`,
    ),
    check('step_kind_ritual_check', sql`(${t.kind} = 'ritual') = (${t.ritualKind} IS NOT NULL)`),
    unique('step_playbook_key_uq').on(t.playbookId, t.key),
    unique('step_stage_ordinal_uq').on(t.stageId, t.ordinal),
  ],
);

export const stepReviewItem = playbooksSchema.table(
  'step_review_item',
  {
    stepId: uuid('step_id')
      .notNull()
      .references(() => step.id),
    ordinal: smallint('ordinal').notNull(),
    text: text('text').notNull(),
  },
  (t) => [primaryKey({ name: 'step_review_item_pkey', columns: [t.stepId, t.ordinal] })],
);

export const stepFallback = playbooksSchema.table('step_fallback', {
  stepId: uuid('step_id')
    .primaryKey()
    .references(() => step.id),
  title: text('title').notNull(),
  instruction: text('instruction').notNull(),
  templateKey: text('template_key').notNull(),
  url: text('url'),
});

/** Platform templates (Markdown with a version); `getTemplate` serves the highest version of a key. */
export const platformTemplate = playbooksSchema.table(
  'platform_template',
  {
    key: text('key').notNull(),
    version: integer('version').notNull(),
    title: text('title').notNull(),
    bodyMd: text('body_md').notNull(),
  },
  (t) => [primaryKey({ name: 'platform_template_pkey', columns: [t.key, t.version] })],
);
