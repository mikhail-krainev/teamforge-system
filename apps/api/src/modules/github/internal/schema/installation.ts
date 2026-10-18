import { sql } from 'drizzle-orm';
import { bigint, check, index, primaryKey, text, uuid } from 'drizzle-orm/pg-core';
import { tstz } from '../../../../platform/db/schema/columns.js';
import { githubSchema } from '../../../../platform/db/schema/module-schemas.js';

/**
 * An installation of the GitHub App on an account (architecture 5.8). It belongs to the account,
 * not to a team: a change of the lead does not hand it over. The row alone gives nobody any right.
 */
export const ghInstallation = githubSchema.table(
  'gh_installation',
  {
    installationId: bigint('installation_id', { mode: 'number' }).primaryKey(),
    accountId: bigint('account_id', { mode: 'number' }).notNull(),
    accountLogin: text('account_login').notNull(),
    accountType: text('account_type').notNull(),
    status: text('status').notNull(),
    updatedAt: tstz('updated_at').notNull(),
  },
  (t) => [
    check('gh_installation_status_check', sql`${t.status} IN ('active','suspended','deleted')`),
  ],
);

/**
 * SEC-02: who proved access to which installation for which team. Written only by the setup
 * callback after the state, the lead check and `GET /user/installations`; revoked, never deleted.
 */
export const installationGrant = githubSchema.table(
  'installation_grant',
  {
    installationId: bigint('installation_id', { mode: 'number' })
      .notNull()
      .references(() => ghInstallation.installationId),
    /** teams.team, no FK across modules. */
    teamId: uuid('team_id').notNull(),
    /** auth.user: the lead who went through the callback. */
    userId: uuid('user_id').notNull(),
    grantedAt: tstz('granted_at').notNull(),
    revokedAt: tstz('revoked_at'),
  },
  (t) => [
    primaryKey({
      name: 'installation_grant_pkey',
      columns: [t.installationId, t.teamId, t.userId],
    }),
    index('installation_grant_team_user_idx')
      .on(t.teamId, t.userId)
      .where(sql`${t.revokedAt} IS NULL`),
  ],
);
