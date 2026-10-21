import { sql } from 'drizzle-orm';
import {
  boolean,
  check,
  foreignKey,
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
import { rewardsSchema } from '../../../../platform/db/schema/module-schemas.js';

/** One credit run per completed project (architecture 5.9); `team_id` is the key and the lock #11 (CC-6, CC-12). */
export const creditRun = rewardsSchema.table(
  'credit_run',
  {
    teamId: uuid('team_id').primaryKey(),
    completedAt: tstz('completed_at').notNull(),
    /** C-17b: `completed_at` + 7 days. */
    coolingUntil: tstz('cooling_until').notNull(),
    status: text('status').notNull(),
    /** AF-13: SHA-256 of the sorted user ids of the team at the completion. */
    rosterHash: bytea('roster_hash').notNull(),
    fraudScore: integer('fraud_score').notNull().default(0),
    creditedAt: tstz('credited_at'),
    version: integer('version').notNull().default(1),
  },
  (t) => [
    check('credit_run_status_check', sql`${t.status} IN ('cooling','frozen','credited','revoked')`),
    index('credit_run_cooling_idx')
      .on(t.coolingUntil)
      .where(sql`${t.status} = 'cooling'`),
    index('credit_run_roster_idx').on(t.rosterHash),
  ],
);

/** The credit of a person for a project: total counter, product types, series (FR-REW-04). */
export const projectCredit = rewardsSchema.table(
  'project_credit',
  {
    teamId: uuid('team_id')
      .notNull()
      .references(() => creditRun.teamId),
    userId: uuid('user_id').notNull(),
    status: text('status').notNull(),
    reason: text('reason'),
    productTypeCode: text('product_type_code').notNull(),
    overdueDays: integer('overdue_days').notNull(),
    completedAt: tstz('completed_at').notNull(),
    rosterHash: bytea('roster_hash').notNull(),
    decidedAt: tstz('decided_at').notNull(),
  },
  (t) => [
    primaryKey({ name: 'project_credit_pkey', columns: [t.teamId, t.userId] }),
    check(
      'project_credit_status_check',
      sql`${t.status} IN ('credited','pending_account','denied','revoked')`,
    ),
    index('project_credit_user_idx').on(t.userId, t.completedAt.desc()),
    index('project_credit_pending_idx')
      .on(t.userId)
      .where(sql`${t.status} = 'pending_account'`),
  ],
);

/** The credit by role (FR-REW-02): a role has a row only when the person has a contribution under it. */
export const credit = rewardsSchema.table(
  'credit',
  {
    teamId: uuid('team_id').notNull(),
    userId: uuid('user_id').notNull(),
    roleCode: text('role_code').notNull(),
    status: text('status').notNull(),
    deficitAtJoin: boolean('deficit_at_join').notNull(),
    creditedAt: tstz('credited_at'),
  },
  (t) => [
    primaryKey({ name: 'credit_pkey', columns: [t.teamId, t.userId, t.roleCode] }),
    foreignKey({
      name: 'credit_project_credit_fk',
      columns: [t.teamId, t.userId],
      foreignColumns: [projectCredit.teamId, projectCredit.userId],
    }),
    check(
      'credit_status_check',
      sql`${t.status} IN ('credited','pending_account','denied','revoked')`,
    ),
    index('credit_user_idx').on(t.userId),
  ],
);

/** Counters (FR-REW-04): `role_code` NULL is the total of credited projects. */
export const counter = rewardsSchema.table(
  'counter',
  {
    userId: uuid('user_id').notNull(),
    roleCode: text('role_code'),
    value: integer('value').notNull(),
  },
  (t) => [
    check('counter_value_check', sql`${t.value} >= 0`),
    unique('counter_uq').on(t.userId, t.roleCode).nullsNotDistinct(),
  ],
);

/** The catalog of badges (FR-REW-05); a seed of the migration. */
export const badgeDef = rewardsSchema.table(
  'badge_def',
  {
    code: text('code').primaryKey(),
    name: text('name').notNull(),
    series: text('series'),
    step: smallint('step'),
    scope: text('scope').notNull(),
    available: boolean('available').notNull(),
  },
  (t) => [
    check(
      'badge_def_series_check',
      sql`${t.series} IS NULL OR ${t.series} IN ('projects','roles','product_types')`,
    ),
    check('badge_def_scope_check', sql`${t.scope} IN ('individual','team')`),
  ],
);

/** A badge of a person. Individual: once per (user, badge); team: once per (team, user, badge) (FR-REW-06). */
export const award = rewardsSchema.table(
  'award',
  {
    id: uuid('id').primaryKey(),
    userId: uuid('user_id').notNull(),
    badgeCode: text('badge_code')
      .notNull()
      .references(() => badgeDef.code),
    scope: text('scope').notNull(),
    teamId: uuid('team_id'),
    awardedAt: tstz('awarded_at').notNull(),
    revokedAt: tstz('revoked_at'),
    revokeReason: text('revoke_reason'),
  },
  (t) => [
    check('award_scope_check', sql`${t.scope} IN ('individual','team')`),
    uniqueIndex('award_individual_uq')
      .on(t.userId, t.badgeCode)
      .where(sql`${t.scope} = 'individual' AND ${t.revokedAt} IS NULL`),
    uniqueIndex('award_team_uq')
      .on(t.teamId, t.userId, t.badgeCode)
      .where(sql`${t.scope} = 'team'`),
    index('award_user_idx')
      .on(t.userId)
      .where(sql`${t.revokedAt} IS NULL`),
    index('award_team_idx').on(t.teamId),
  ],
);

/** What a rule of the anti-fraud found; one row per rule and phase (AF-25: never changed after the insert). */
export const fraudSignal = rewardsSchema.table(
  'fraud_signal',
  {
    id: uuid('id').primaryKey(),
    teamId: uuid('team_id').notNull(),
    phase: text('phase').notNull(),
    ruleCode: text('rule_code').notNull(),
    action: text('action').notNull(),
    score: integer('score').notNull(),
    data: jsonb('data').notNull(),
    createdAt: tstz('created_at').notNull(),
  },
  (t) => [
    check('fraud_signal_phase_check', sql`${t.phase} IN ('completion','cooling_end','step_check')`),
    check('fraud_signal_action_check', sql`${t.action} IN ('block','flag','signal','info')`),
    uniqueIndex('fraud_signal_uq').on(t.teamId, t.phase, t.ruleCode),
  ],
);

/** The queue of manual review (FR-REW-16); one open case per team. */
export const fraudCase = rewardsSchema.table(
  'fraud_case',
  {
    id: uuid('id').primaryKey(),
    teamId: uuid('team_id').notNull(),
    status: text('status').notNull(),
    openedAt: tstz('opened_at').notNull(),
    decidedBy: uuid('decided_by'),
    decidedAt: tstz('decided_at'),
    comment: text('comment'),
  },
  (t) => [
    check('fraud_case_status_check', sql`${t.status} IN ('open','ok','violation')`),
    uniqueIndex('fraud_case_open_uq')
      .on(t.teamId)
      .where(sql`${t.status} = 'open'`),
    index('fraud_case_status_idx').on(t.status, t.openedAt, t.id),
    index('fraud_case_team_idx').on(t.teamId),
  ],
);

/** A complaint of a participant in the cooling (FR-REW-11). */
export const dispute = rewardsSchema.table(
  'dispute',
  {
    id: uuid('id').primaryKey(),
    teamId: uuid('team_id').notNull(),
    userId: uuid('user_id').notNull(),
    text: text('text').notNull(),
    createdAt: tstz('created_at').notNull(),
  },
  (t) => [
    index('dispute_team_idx').on(t.teamId),
    /** A person disputes a project once. */
    uniqueIndex('dispute_team_user_uq').on(t.teamId, t.userId),
  ],
);

/** The journal of the decisions of the administrator (AF-25): who, what, when, why. */
export const adminAudit = rewardsSchema.table(
  'admin_audit',
  {
    id: uuid('id').primaryKey(),
    actorUserId: uuid('actor_user_id').notNull(),
    action: text('action').notNull(),
    targetType: text('target_type').notNull(),
    targetId: text('target_id').notNull(),
    reason: text('reason').notNull(),
    data: jsonb('data').notNull(),
    at: tstz('at').notNull(),
  },
  (t) => [index('admin_audit_target_idx').on(t.targetType, t.targetId, t.at)],
);
