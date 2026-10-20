import { sql } from 'drizzle-orm';
import {
  boolean,
  check,
  index,
  integer,
  primaryKey,
  smallint,
  text,
  uuid,
} from 'drizzle-orm/pg-core';
import { tstz } from '../../../../platform/db/schema/columns.js';
import { workspaceSchema } from '../../../../platform/db/schema/module-schemas.js';

/** Lead's confirmation that a member took part in a stage (FR-WORK-17). */
export const participationConfirm = workspaceSchema.table(
  'participation_confirm',
  {
    teamId: uuid('team_id').notNull(),
    userId: uuid('user_id').notNull(),
    stageOrdinal: smallint('stage_ordinal').notNull(),
    confirmedBy: uuid('confirmed_by').notNull(),
    at: tstz('at').notNull(),
  },
  (t) => [primaryKey({ columns: [t.teamId, t.userId, t.stageOrdinal] })],
);

/** Result of one check of the release URL; only a reason code is stored (SEC-05). */
export const releaseCheck = workspaceSchema.table(
  'release_check',
  {
    id: uuid('id').primaryKey(),
    teamId: uuid('team_id').notNull(),
    url: text('url').notNull(),
    checkKey: text('check_key').notNull(),
    ok: boolean('ok').notNull(),
    httpStatus: integer('http_status'),
    reason: text('reason'),
    checkedAt: tstz('checked_at').notNull(),
  },
  (t) => [
    check(
      'release_check_reason_check',
      sql`${t.reason} IN ('HTTP_STATUS','TOO_SMALL','PLACEHOLDER_TITLE','TIMEOUT','BLOCKED_ADDRESS','BLOCKED_PORT','TLS_ERROR','TOO_MANY_REDIRECTS','DNS_ERROR')`,
    ),
    index('release_check_team_idx').on(t.teamId, t.url, t.checkedAt.desc()),
  ],
);
