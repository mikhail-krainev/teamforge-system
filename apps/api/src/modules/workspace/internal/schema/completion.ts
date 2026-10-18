import { sql } from 'drizzle-orm';
import { check, index, integer, jsonb, text, uuid } from 'drizzle-orm/pg-core';
import { tstz } from '../../../../platform/db/schema/columns.js';
import { workspaceSchema } from '../../../../platform/db/schema/module-schemas.js';

/** One run of the completion checks of a team (FR-WORK-13): the results are rows of `results`. */
export const completionCheck = workspaceSchema.table(
  'completion_check',
  {
    id: uuid('id').primaryKey(),
    teamId: uuid('team_id').notNull(),
    status: text('status').notNull(),
    results: jsonb('results')
      .notNull()
      .default(sql`'[]'`),
    requestedBy: uuid('requested_by').notNull(),
    requestedAt: tstz('requested_at').notNull(),
    finishedAt: tstz('finished_at'),
    validUntil: tstz('valid_until'),
  },
  (t) => [
    check(
      'completion_check_status_check',
      sql`${t.status} IN ('queued','running','done','failed')`,
    ),
    index('completion_check_team_idx').on(t.teamId, t.requestedAt.desc()),
  ],
);

/** The closed project: the primary key keeps it to one row per team (CC-13); `snapshot` never changes. */
export const projectCompletion = workspaceSchema.table(
  'project_completion',
  {
    teamId: uuid('team_id').primaryKey(),
    completedAt: tstz('completed_at').notNull(),
    plannedEndAt: tstz('planned_end_at').notNull(),
    overdueDays: integer('overdue_days').notNull(),
    snapshot: jsonb('snapshot').notNull(),
    completedBy: uuid('completed_by').notNull(),
  },
  (t) => [
    check('project_completion_overdue_days_check', sql`${t.overdueDays} >= 0`),
    index('project_completion_completed_idx').on(t.completedAt, t.teamId),
  ],
);
