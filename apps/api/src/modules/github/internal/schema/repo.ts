import { sql } from 'drizzle-orm';
import {
  bigint,
  boolean,
  check,
  index,
  integer,
  jsonb,
  text,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { tstz } from '../../../../platform/db/schema/columns.js';
import { githubSchema } from '../../../../platform/db/schema/module-schemas.js';
import { ghInstallation } from './installation.js';

/** The repository of a team (FR-GH-02). One repository, one team: `repo_link_repository_uq` (CC-9). */
export const repoLink = githubSchema.table(
  'repo_link',
  {
    id: uuid('id').primaryKey(),
    /** teams.team, no FK across modules. */
    teamId: uuid('team_id').notNull(),
    repositoryId: bigint('repository_id', { mode: 'number' }).notNull(),
    installationId: bigint('installation_id', { mode: 'number' })
      .notNull()
      .references(() => ghInstallation.installationId),
    fullName: text('full_name').notNull(),
    isPrivate: boolean('is_private').notNull(),
    isFork: boolean('is_fork').notNull(),
    repoCreatedAt: tstz('repo_created_at').notNull(),
    status: text('status').notNull(),
    linkedBy: uuid('linked_by').notNull(),
    linkedAt: tstz('linked_at').notNull(),
    unlinkedAt: tstz('unlinked_at'),
    unlinkReason: text('unlink_reason'),
  },
  (t) => [
    check('repo_link_status_check', sql`${t.status} IN ('active','completed','unlinked')`),
    /** CC-9, AF-01: the repository of an active or a completed project is taken. */
    uniqueIndex('repo_link_repository_uq')
      .on(t.repositoryId)
      .where(sql`${t.status} IN ('active','completed')`),
    uniqueIndex('repo_link_team_active_uq')
      .on(t.teamId)
      .where(sql`${t.status} = 'active'`),
    index('repo_link_installation_idx').on(t.installationId),
    /** `findHolding`: the link of a team that is active or completed, newest first. */
    index('repo_link_team_idx').on(t.teamId, t.linkedAt.desc()),
  ],
);

/** Where the daily reconciliation stopped and the last CI verdict (architecture 7.4). */
export const repoSyncState = githubSchema.table('repo_sync_state', {
  repositoryId: bigint('repository_id', { mode: 'number' }).primaryKey(),
  issuesEtag: text('issues_etag'),
  pullsEtag: text('pulls_etag'),
  /** Set only when both feeds were read to the end (or to the position of the previous run). */
  lastSyncedAt: tstz('last_synced_at'),
  /** The page a feed continues from after a run that hit its page budget; null when the feed was finished. */
  issuesResumePage: integer('issues_resume_page'),
  pullsResumePage: integer('pulls_resume_page'),
  /** When the first unfinished run of the current round started: it becomes `last_synced_at` at the end. */
  pendingSyncStartedAt: tstz('pending_sync_started_at'),
  ciState: text('ci_state'),
  ciCheckedAt: tstz('ci_checked_at'),
});

/** Result of a repository check (`exists` on saving a step, `final` at the completion). */
export const repoCheck = githubSchema.table(
  'repo_check',
  {
    id: uuid('id').primaryKey(),
    teamId: uuid('team_id').notNull(),
    repositoryId: bigint('repository_id', { mode: 'number' }).notNull(),
    kind: text('kind').notNull(),
    ok: boolean('ok').notNull(),
    details: jsonb('details').notNull(),
    checkedAt: tstz('checked_at').notNull(),
  },
  (t) => [
    check('repo_check_kind_check', sql`${t.kind} IN ('exists','final')`),
    index('repo_check_team_idx').on(t.teamId, t.kind, t.checkedAt.desc()),
  ],
);

/** Age and activity of a GitHub account (FR-GH-09). */
export const accountCheck = githubSchema.table('account_check', {
  githubUserId: bigint('github_user_id', { mode: 'number' }).primaryKey(),
  accountCreatedAt: tstz('account_created_at').notNull(),
  publicRepos: integer('public_repos').notNull(),
  hasPublicActivity: boolean('has_public_activity').notNull(),
  checkedAt: tstz('checked_at').notNull(),
});
