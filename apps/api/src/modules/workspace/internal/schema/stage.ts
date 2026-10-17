import { sql } from 'drizzle-orm';
import {
  boolean,
  check,
  date,
  index,
  integer,
  smallint,
  text,
  unique,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { tstz } from '../../../../platform/db/schema/columns.js';
import { workspaceSchema } from '../../../../platform/db/schema/module-schemas.js';

/** Route of a started project (architecture 5.7): one row per playbook stage, at most one `open`. */
export const projectStage = workspaceSchema.table(
  'project_stage',
  {
    id: uuid('id').primaryKey(),
    /** teams.team, no FK across modules. */
    teamId: uuid('team_id').notNull(),
    stageKey: text('stage_key').notNull(),
    ordinal: smallint('ordinal').notNull(),
    title: text('title').notNull(),
    durationDays: integer('duration_days').notNull(),
    status: text('status').notNull(),
    openedAt: tstz('opened_at'),
    dueAt: tstz('due_at'),
    closedAt: tstz('closed_at'),
    closedBy: uuid('closed_by'),
    version: integer('version').notNull().default(1),
  },
  (t) => [
    check('project_stage_status_check', sql`${t.status} IN ('pending','open','closed')`),
    unique('project_stage_team_ordinal_uq').on(t.teamId, t.ordinal),
    /** CC-5: two open stages in one project are impossible. */
    uniqueIndex('project_stage_one_open_uq')
      .on(t.teamId)
      .where(sql`${t.status} = 'open'`),
    index('project_stage_due_idx')
      .on(t.dueAt)
      .where(sql`${t.status} = 'open'`),
  ],
);

/** One step of a stage as a task of the team. `UNIQUE (project_stage_id, step_key)` makes the creation idempotent. */
export const checklistItem = workspaceSchema.table(
  'checklist_item',
  {
    id: uuid('id').primaryKey(),
    teamId: uuid('team_id').notNull(),
    projectStageId: uuid('project_stage_id')
      .notNull()
      .references(() => projectStage.id),
    stepKey: text('step_key').notNull(),
    kind: text('kind').notNull(),
    submission: text('submission'),
    ritualKind: text('ritual_kind'),
    required: boolean('required').notNull(),
    ownerRole: text('owner_role').notNull(),
    altRoles: text('alt_roles').array().notNull(),
    status: text('status').notNull(),
    assigneeUserId: uuid('assignee_user_id'),
    roleCode: text('role_code'),
    fallbackUsed: boolean('fallback_used').notNull().default(false),
    linkUrl: text('link_url'),
    linkStatus: text('link_status').notNull().default('none'),
    linkCheckedAt: tstz('link_checked_at'),
    heldOn: date('held_on', { mode: 'string' }),
    externalUrl: text('external_url'),
    outcome: text('outcome'),
    doneBy: uuid('done_by'),
    doneAt: tstz('done_at'),
    version: integer('version').notNull().default(1),
    updatedAt: tstz('updated_at').notNull(),
  },
  (t) => [
    check('checklist_item_status_check', sql`${t.status} IN ('open','done')`),
    check(
      'checklist_item_link_status_check',
      sql`${t.linkStatus} IN ('none','unchecked','ok','broken','rejected')`,
    ),
    unique('checklist_item_stage_step_uq').on(t.projectStageId, t.stepKey),
    index('checklist_item_team_stage_idx').on(t.teamId, t.projectStageId),
    index('checklist_item_assignee_idx')
      .on(t.assigneeUserId)
      .where(sql`${t.status} = 'open'`),
  ],
);
