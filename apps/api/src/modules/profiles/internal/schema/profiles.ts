import { sql } from 'drizzle-orm';
import {
  boolean,
  check,
  date,
  index,
  integer,
  jsonb,
  primaryKey,
  smallint,
  text,
  unique,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { bytea, tstz } from '../../../../platform/db/schema/columns.js';
import { profilesSchema } from '../../../../platform/db/schema/module-schemas.js';

/** Roles (FR-PROF-09). A used entry is deactivated, never deleted. */
export const role = profilesSchema.table('role', {
  code: text('code').primaryKey(),
  name: text('name').notNull(),
  active: boolean('active').notNull().default(true),
  ordinal: integer('ordinal').notNull(),
});

export const stackTag = profilesSchema.table(
  'stack_tag',
  {
    code: text('code').primaryKey(),
    name: text('name').notNull(),
    active: boolean('active').notNull().default(true),
  },
  // Prefix search (autocomplete) with LIKE 'abc%' under any collation.
  (t) => [index('stack_tag_code_prefix_idx').on(t.code.op('text_pattern_ops'))],
);

/** `user_id` references auth.user by id only: modules do not share foreign keys (ADR-0001). */
export const profile = profilesSchema.table(
  'profile',
  {
    userId: uuid('user_id').primaryKey(),
    displayName: text('display_name').notNull(),
    timezone: text('timezone').notNull(),
    hoursPerWeek: smallint('hours_per_week').notNull(),
    portfolioUrl: text('portfolio_url'),
    strengths: jsonb('strengths')
      .notNull()
      .default(sql`'[]'::jsonb`),
    weaknesses: jsonb('weaknesses')
      .notNull()
      .default(sql`'[]'::jsonb`),
    /** Normalised hash of the free text for AF-18. */
    textFingerprint: bytea('text_fingerprint'),
    version: integer('version').notNull().default(1),
    updatedAt: tstz('updated_at').notNull(),
  },
  (t) => [
    check('profile_display_name_check', sql`char_length(${t.displayName}) BETWEEN 2 AND 60`),
    check('profile_hours_check', sql`${t.hoursPerWeek} BETWEEN 3 AND 40`),
    index('profile_text_fp_idx').on(t.textFingerprint),
  ],
);

export const profileRolePref = profilesSchema.table(
  'profile_role_pref',
  {
    userId: uuid('user_id')
      .notNull()
      .references(() => profile.userId, { onDelete: 'cascade' }),
    roleCode: text('role_code')
      .notNull()
      .references(() => role.code),
    level: text('level').notNull(),
    ordinal: smallint('ordinal').notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.userId, t.roleCode], name: 'profile_role_pref_pkey' }),
    check('profile_role_pref_level_check', sql`${t.level} IN ('beginner','junior','middle')`),
    // The migration makes this constraint DEFERRABLE INITIALLY DEFERRED (reordering in one save);
    // drizzle cannot express that, so the generated SQL is edited by hand.
    unique('profile_role_pref_ordinal_uq').on(t.userId, t.ordinal),
    index('profile_role_pref_role_idx').on(t.roleCode, t.level),
  ],
);

export const profileStack = profilesSchema.table(
  'profile_stack',
  {
    userId: uuid('user_id')
      .notNull()
      .references(() => profile.userId, { onDelete: 'cascade' }),
    stackTagCode: text('stack_tag_code')
      .notNull()
      .references(() => stackTag.code),
  },
  (t) => [primaryKey({ columns: [t.userId, t.stackTagCode], name: 'profile_stack_pkey' })],
);

export const profileExperience = profilesSchema.table(
  'profile_experience',
  {
    id: uuid('id').primaryKey(),
    userId: uuid('user_id')
      .notNull()
      .references(() => profile.userId, { onDelete: 'cascade' }),
    title: text('title').notNull(),
    description: text('description'),
    periodFrom: date('period_from', { mode: 'string' }).notNull(),
    periodTo: date('period_to', { mode: 'string' }),
    ordinal: smallint('ordinal').notNull(),
  },
  (t) => [index('profile_experience_user_idx').on(t.userId, t.ordinal)],
);

export const resumeUpload = profilesSchema.table(
  'resume_upload',
  {
    id: uuid('id').primaryKey(),
    userId: uuid('user_id').notNull(),
    /** NULL after the file is deleted. */
    storageKey: text('storage_key'),
    mime: text('mime').notNull(),
    sizeBytes: integer('size_bytes').notNull(),
    sha256: bytea('sha256').notNull(),
    status: text('status').notNull(),
    failureReason: text('failure_reason'),
    extractedText: text('extracted_text'),
    suggestions: jsonb('suggestions'),
    keepFile: boolean('keep_file').notNull().default(false),
    createdAt: tstz('created_at').notNull(),
    processedAt: tstz('processed_at'),
    confirmedAt: tstz('confirmed_at'),
  },
  (t) => [
    check(
      'resume_upload_status_check',
      sql`${t.status} IN ('queued','processing','done','failed')`,
    ),
    index('resume_upload_user_idx').on(t.userId, t.createdAt.desc()),
  ],
);

/** Projection of `workspace.project_completed`: who may review whom, until when (FR-PROF-08, C-27). */
export const reviewEligibility = profilesSchema.table(
  'review_eligibility',
  {
    teamId: uuid('team_id').notNull(),
    userId: uuid('user_id').notNull(),
    teamName: text('team_name').notNull(),
    /** `completed_at` + 14 days (C-27). */
    windowUntil: tstz('window_until').notNull(),
  },
  (t) => [
    primaryKey({ name: 'review_eligibility_pkey', columns: [t.teamId, t.userId] }),
    index('review_eligibility_window_idx').on(t.windowUntil),
    index('review_eligibility_user_idx').on(t.userId),
  ],
);

/**
 * What the subject reads (SEC-04): no author column and no time of writing. `id` is a random UUID v4
 * (an exception to the UUID v7 rule: no timestamp in it), `sort_key` orders a batch without time.
 */
export const peerReview = profilesSchema.table(
  'peer_review',
  {
    id: uuid('id').primaryKey(),
    teamId: uuid('team_id').notNull(),
    subjectUserId: uuid('subject_user_id').notNull(),
    text: text('text').notNull(),
    status: text('status').notNull().default('pending'),
    /** The day the window closed: one for the whole batch. */
    publishedOn: date('published_on', { mode: 'string' }),
    sortKey: integer('sort_key').notNull(),
    /** Withheld reviews are deleted after this day (window + 30 days). */
    purgeAfter: date('purge_after', { mode: 'string' }),
  },
  (t) => [
    check('peer_review_text_check', sql`char_length(${t.text}) BETWEEN 1 AND 2000`),
    check('peer_review_status_check', sql`${t.status} IN ('pending','published','withheld')`),
    index('peer_review_subject_idx')
      .on(t.subjectUserId, t.publishedOn.desc(), t.teamId, t.sortKey, t.id)
      .where(sql`${t.status} = 'published'`),
    index('peer_review_team_subject_idx').on(t.teamId, t.subjectUserId),
    index('peer_review_purge_idx')
      .on(t.purgeAfter)
      .where(sql`${t.status} = 'withheld'`),
  ],
);

/** Only the anti-spam pair and the erasure of an author; never joined into what a subject reads (SEC-04). */
export const peerReviewAuthorship = profilesSchema.table(
  'peer_review_authorship',
  {
    reviewId: uuid('review_id')
      .primaryKey()
      .references(() => peerReview.id, { onDelete: 'cascade' }),
    teamId: uuid('team_id').notNull(),
    authorUserId: uuid('author_user_id').notNull(),
    subjectUserId: uuid('subject_user_id').notNull(),
  },
  (t) => [
    check('peer_review_authorship_self_check', sql`${t.authorUserId} <> ${t.subjectUserId}`),
    uniqueIndex('peer_review_pair_uq').on(t.teamId, t.authorUserId, t.subjectUserId),
    index('peer_review_authorship_author_idx').on(t.authorUserId),
  ],
);
