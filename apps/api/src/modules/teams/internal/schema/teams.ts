import { sql } from 'drizzle-orm';
import {
  bigint,
  boolean,
  check,
  index,
  integer,
  smallint,
  text,
  unique,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { bytea, tstz } from '../../../../platform/db/schema/columns.js';
import { teamsSchema } from '../../../../platform/db/schema/module-schemas.js';

/**
 * Team, seats, membership and tickets (architecture 5.5). Identifiers of other modules
 * (`auth.user`, `profiles.role`, `playbooks.*`, `matching.*`) are plain columns without FK (ADR-0002).
 */
export const team = teamsSchema.table(
  'team',
  {
    id: uuid('id').primaryKey(),
    name: text('name').notNull(),
    description: text('description').notNull(),
    productTypeCode: text('product_type_code').notNull(),
    playbookId: uuid('playbook_id').notNull(),
    /** NULL while a leader vote runs without a leader. */
    leadUserId: uuid('lead_user_id'),
    status: text('status').notNull(),
    statusReason: text('status_reason'),
    statusBeforeVote: text('status_before_vote'),
    timezone: text('timezone').notNull(),
    hoursPerWeek: smallint('hours_per_week').notNull(),
    /** C-02: changes only under the team lock. */
    memberCount: smallint('member_count').notNull().default(0),
    /** C-04: open + filled seats. */
    seatCount: smallint('seat_count').notNull().default(0),
    startedAt: tstz('started_at'),
    plannedEndAt: tstz('planned_end_at'),
    completedAt: tstz('completed_at'),
    suspendedAt: tstz('suspended_at'),
    suspendedTotalSeconds: integer('suspended_total_seconds').notNull().default(0),
    releaseUrl: text('release_url'),
    leadLastActiveAt: tstz('lead_last_active_at'),
    version: integer('version').notNull().default(1),
    createdBy: uuid('created_by').notNull(),
    createdAt: tstz('created_at').notNull(),
    updatedAt: tstz('updated_at').notNull(),
  },
  (t) => [
    check(
      'team_status_check',
      sql`${t.status} IN ('forming','active','voting','suspended','completed','archived')`,
    ),
    check('team_member_count_check', sql`${t.memberCount} BETWEEN 0 AND 8`),
    check('team_seat_count_check', sql`${t.seatCount} BETWEEN 0 AND 12`),
    index('team_catalog_idx')
      .on(t.status, t.productTypeCode, t.createdAt.desc(), t.id.desc())
      .where(sql`${t.status} IN ('forming','active')`),
    index('team_status_started_idx').on(t.status, t.startedAt),
  ],
);

export const seat = teamsSchema.table(
  'seat',
  {
    id: uuid('id').primaryKey(),
    teamId: uuid('team_id')
      .notNull()
      .references(() => team.id),
    roleCode: text('role_code').notNull(),
    ordinal: smallint('ordinal').notNull(),
    desired: boolean('desired').notNull().default(false),
    desiredChangedAt: tstz('desired_changed_at'),
    minLevel: text('min_level').notNull(),
    minHours: smallint('min_hours').notNull(),
    stack: text('stack')
      .array()
      .notNull()
      .default(sql`'{}'::text[]`),
    status: text('status').notNull(),
    /** Last time the seat was opened (FR-MATCH-06). */
    openedAt: tstz('opened_at'),
    version: integer('version').notNull().default(1),
  },
  (t) => [
    check('seat_min_level_check', sql`${t.minLevel} IN ('beginner','junior','middle')`),
    check('seat_status_check', sql`${t.status} IN ('open','filled','closed')`),
    unique('seat_team_role_ordinal_uq').on(t.teamId, t.roleCode, t.ordinal),
    index('seat_team_status_role_idx').on(t.teamId, t.status, t.roleCode),
    index('seat_open_role_idx')
      .on(t.roleCode, t.openedAt)
      .where(sql`${t.status} = 'open'`),
  ],
);

export const membership = teamsSchema.table(
  'membership',
  {
    id: uuid('id').primaryKey(),
    teamId: uuid('team_id')
      .notNull()
      .references(() => team.id),
    userId: uuid('user_id').notNull(),
    status: text('status').notNull(),
    joinedVia: text('joined_via').notNull(),
    joinedAt: tstz('joined_at').notNull(),
    trialUntil: tstz('trial_until'),
    trialConfirmedAt: tstz('trial_confirmed_at'),
    /** matching.search_application, for `auto` joins. */
    applicationId: uuid('application_id'),
    leftAt: tstz('left_at'),
    leftReason: text('left_reason'),
  },
  (t) => [
    check('membership_status_check', sql`${t.status} IN ('active','left','removed')`),
    check(
      'membership_joined_via_check',
      sql`${t.joinedVia} IN ('creator','invite','offer','request','auto','vote')`,
    ),
    check(
      'membership_left_reason_check',
      sql`${t.leftReason} IN ('left','removed_in_trial','deleted_account','team_archived')`,
    ),
    uniqueIndex('membership_active_uq')
      .on(t.teamId, t.userId)
      .where(sql`${t.status} = 'active'`),
    index('membership_user_status_idx').on(t.userId, t.status),
    index('membership_trial_idx')
      .on(t.trialUntil)
      .where(
        sql`${t.status} = 'active' AND ${t.trialUntil} IS NOT NULL AND ${t.trialConfirmedAt} IS NULL`,
      ),
  ],
);

/** The record of an occupied seat (FR-TEAM-25). */
export const seatAssignment = teamsSchema.table(
  'seat_assignment',
  {
    id: uuid('id').primaryKey(),
    seatId: uuid('seat_id')
      .notNull()
      .references(() => seat.id),
    teamId: uuid('team_id')
      .notNull()
      .references(() => team.id),
    membershipId: uuid('membership_id')
      .notNull()
      .references(() => membership.id),
    userId: uuid('user_id').notNull(),
    roleCode: text('role_code').notNull(),
    joinedVia: text('joined_via').notNull(),
    startedAt: tstz('started_at').notNull(),
    endedAt: tstz('ended_at'),
    deficitAtJoin: boolean('deficit_at_join').notNull(),
    deficitOpenSeats: integer('deficit_open_seats').notNull(),
    deficitQueued: integer('deficit_queued').notNull(),
  },
  (t) => [
    // CC-1: one holder per seat.
    uniqueIndex('seat_assignment_active_seat_uq')
      .on(t.seatId)
      .where(sql`${t.endedAt} IS NULL`),
    // FR-TEAM-07: a person holds a role at most once in a team.
    uniqueIndex('seat_assignment_active_role_uq')
      .on(t.teamId, t.userId, t.roleCode)
      .where(sql`${t.endedAt} IS NULL`),
    index('seat_assignment_membership_idx').on(t.membershipId),
  ],
);

export const invitation = teamsSchema.table(
  'invitation',
  {
    id: uuid('id').primaryKey(),
    teamId: uuid('team_id')
      .notNull()
      .references(() => team.id),
    seatId: uuid('seat_id')
      .notNull()
      .references(() => seat.id),
    /** sha256 of the 32-byte base64url token. */
    tokenHash: bytea('token_hash').notNull(),
    /** SEC-18: the login is resolved to an id at creation and compared by id only. */
    inviteeGithubUserId: bigint('invitee_github_user_id', { mode: 'number' }),
    inviteeGithubLogin: text('invitee_github_login'),
    /** SEC-18: HMAC of the normalised email; the address itself is never stored. */
    inviteeEmailHmac: bytea('invitee_email_hmac'),
    status: text('status').notNull(),
    expiresAt: tstz('expires_at').notNull(),
    usedBy: uuid('used_by'),
    usedAt: tstz('used_at'),
    createdBy: uuid('created_by').notNull(),
    createdAt: tstz('created_at').notNull(),
  },
  (t) => [
    check('invitation_status_check', sql`${t.status} IN ('active','used','revoked','expired')`),
    uniqueIndex('invitation_token_uq').on(t.tokenHash),
    index('invitation_team_active_idx')
      .on(t.teamId)
      .where(sql`${t.status} = 'active'`),
    index('invitation_cleanup_idx')
      .on(t.createdAt)
      .where(sql`${t.status} <> 'active'`),
  ],
);

/** An offer from the lead or a request from a candidate. */
export const seatOffer = teamsSchema.table(
  'seat_offer',
  {
    id: uuid('id').primaryKey(),
    teamId: uuid('team_id')
      .notNull()
      .references(() => team.id),
    seatId: uuid('seat_id')
      .notNull()
      .references(() => seat.id),
    userId: uuid('user_id').notNull(),
    direction: text('direction').notNull(),
    status: text('status').notNull(),
    message: text('message'),
    expiresAt: tstz('expires_at').notNull(),
    createdAt: tstz('created_at').notNull(),
    decidedAt: tstz('decided_at'),
  },
  (t) => [
    check('seat_offer_direction_check', sql`${t.direction} IN ('lead_to_user','user_to_lead')`),
    check(
      'seat_offer_status_check',
      sql`${t.status} IN ('pending','accepted','rejected','expired','cancelled')`,
    ),
    uniqueIndex('seat_offer_pending_uq')
      .on(t.seatId, t.userId)
      .where(sql`${t.status} = 'pending'`),
    index('seat_offer_user_idx').on(t.userId, t.createdAt.desc()),
    index('seat_offer_team_idx').on(t.teamId, t.status, t.createdAt.desc()),
  ],
);

/** The lead's decision after a member left (FR-TEAM-12). */
export const departure = teamsSchema.table(
  'departure',
  {
    id: uuid('id').primaryKey(),
    teamId: uuid('team_id')
      .notNull()
      .references(() => team.id),
    membershipId: uuid('membership_id')
      .notNull()
      .references(() => membership.id),
    userId: uuid('user_id').notNull(),
    seatIds: uuid('seat_ids').array().notNull(),
    reason: text('reason').notNull(),
    decision: text('decision').notNull(),
    dueAt: tstz('due_at').notNull(),
    decidedAt: tstz('decided_at'),
    decidedBy: uuid('decided_by'),
  },
  (t) => [
    check('departure_decision_check', sql`${t.decision} IN ('pending','replace','continue')`),
    index('departure_pending_idx')
      .on(t.dueAt)
      .where(sql`${t.decision} = 'pending'`),
    index('departure_team_idx').on(t.teamId, t.decision),
  ],
);
