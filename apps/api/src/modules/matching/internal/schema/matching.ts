import { sql } from 'drizzle-orm';
import {
  boolean,
  check,
  index,
  integer,
  jsonb,
  numeric,
  primaryKey,
  smallint,
  text,
  unique,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { tstz } from '../../../../platform/db/schema/columns.js';
import { matchingSchema } from '../../../../platform/db/schema/module-schemas.js';

/**
 * Search queue and matching (architecture 5.6). Identifiers of other modules (`auth.user`,
 * `teams.*`) are plain columns without a foreign key (ADR-0002).
 */
export const searchApplication = matchingSchema.table(
  'search_application',
  {
    id: uuid('id').primaryKey(),
    userId: uuid('user_id').notNull(),
    status: text('status').notNull(),
    /** Kept on update and on restoring after an exclusion (FR-MATCH-04, FR-MATCH-08). */
    enqueuedAt: tstz('enqueued_at').notNull(),
    /** Time spent in a team before an exclusion (FR-MATCH-08). */
    pausedSeconds: integer('paused_seconds').notNull().default(0),
    fulfilledAt: tstz('fulfilled_at'),
    fulfilledSeatId: uuid('fulfilled_seat_id'),
    fulfilledRoleCode: text('fulfilled_role_code'),
    fulfilledTeamId: uuid('fulfilled_team_id'),
    cancelledAt: tstz('cancelled_at'),
    restoredAt: tstz('restored_at'),
    version: integer('version').notNull().default(1),
  },
  (t) => [
    check(
      'search_application_status_check',
      sql`${t.status} IN ('active','fulfilled','cancelled')`,
    ),
    // CC-10: one active application per user. Registered as APPLICATION_EXISTS in constraints.ts.
    uniqueIndex('search_application_active_uq')
      .on(t.userId)
      .where(sql`${t.status} = 'active'`),
    index('search_application_queue_idx')
      .on(t.enqueuedAt, t.id)
      .where(sql`${t.status} = 'active'`),
  ],
);

export const applicationRole = matchingSchema.table(
  'application_role',
  {
    applicationId: uuid('application_id')
      .notNull()
      .references(() => searchApplication.id, { onDelete: 'cascade' }),
    roleCode: text('role_code').notNull(),
    priority: smallint('priority').notNull(),
    addedAt: tstz('added_at').notNull(),
    /** Copy of the application status for the queue-count index. */
    isActive: boolean('is_active').notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.applicationId, t.roleCode], name: 'application_role_pkey' }),
    check('application_role_priority_check', sql`${t.priority} BETWEEN 1 AND 5`),
    // The migration makes this constraint DEFERRABLE INITIALLY DEFERRED (priorities may be swapped
    // in one save); drizzle cannot express that, so the generated SQL is edited by hand. It is
    // never an ON CONFLICT target.
    unique('application_role_priority_uq').on(t.applicationId, t.priority),
    index('application_role_queue_idx')
      .on(t.roleCode, t.addedAt)
      .where(sql`${t.isActive}`),
  ],
);

/** Team that excluded the candidate in the trial period (FR-MATCH-08). */
export const applicationExclusion = matchingSchema.table(
  'application_exclusion',
  {
    applicationId: uuid('application_id')
      .notNull()
      .references(() => searchApplication.id, { onDelete: 'cascade' }),
    teamId: uuid('team_id').notNull(),
  },
  (t) => [primaryKey({ columns: [t.applicationId, t.teamId], name: 'application_exclusion_pkey' })],
);

/** Precomputed recommendations (FR-MATCH-01, FR-MATCH-02). */
export const matchCandidate = matchingSchema.table(
  'match_candidate',
  {
    seatId: uuid('seat_id').notNull(),
    userId: uuid('user_id').notNull(),
    teamId: uuid('team_id').notNull(),
    roleCode: text('role_code').notNull(),
    score: numeric('score', { precision: 4, scale: 3 }).notNull(),
    reasons: jsonb('reasons').notNull(),
    inQueue: boolean('in_queue').notNull(),
    computedAt: tstz('computed_at').notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.seatId, t.userId], name: 'match_candidate_pkey' }),
    index('match_candidate_seat_idx').on(t.seatId, t.score.desc(), t.userId),
    index('match_candidate_user_idx').on(t.userId, t.score.desc(), t.seatId),
  ],
);

/** Projection of `rewards.credits_changed`. */
export const candidateStats = matchingSchema.table(
  'candidate_stats',
  {
    userId: uuid('user_id').notNull(),
    roleCode: text('role_code').notNull(),
    completedCount: integer('completed_count').notNull(),
  },
  (t) => [primaryKey({ columns: [t.userId, t.roleCode], name: 'candidate_stats_pkey' })],
);

/** Closed waits (FR-MATCH-10); no user id, so it survives account deletion. */
export const waitSample = matchingSchema.table(
  'wait_sample',
  {
    id: uuid('id').primaryKey(),
    applicationId: uuid('application_id').notNull(),
    roleCode: text('role_code').notNull(),
    waitedSeconds: integer('waited_seconds').notNull(),
    matchedAt: tstz('matched_at').notNull(),
  },
  (t) => [
    uniqueIndex('wait_sample_application_uq').on(t.applicationId, t.matchedAt),
    index('wait_sample_role_idx').on(t.roleCode, t.matchedAt.desc()),
  ],
);

export const autoAddLog = matchingSchema.table(
  'auto_add_log',
  {
    id: uuid('id').primaryKey(),
    runId: uuid('run_id').notNull(),
    applicationId: uuid('application_id').notNull(),
    seatId: uuid('seat_id').notNull(),
    outcome: text('outcome').notNull(),
    reason: text('reason'),
    at: tstz('at').notNull(),
  },
  (t) => [index('auto_add_log_application_idx').on(t.applicationId, t.at.desc())],
);
