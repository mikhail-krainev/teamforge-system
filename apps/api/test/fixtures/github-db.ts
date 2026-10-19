import { countOf } from './assertions.js';
import type { World } from './world.js';

/**
 * SQL read-backs for the slice 6 tables (docs/architecture.md 5.7 `workspace.contribution`,
 * `completion_check`, `project_completion`; 5.8 `github.*`). Tests read stored state with them; a
 * mismatch of a name means the migration of S6-03 deviates from the architecture.
 */

export interface GrantRow {
  installation_id: string | number;
  team_id: string;
  user_id: string;
  granted_at: Date;
  revoked_at: Date | null;
}

export interface RepoLinkRow {
  id: string;
  team_id: string;
  repository_id: string | number;
  installation_id: string | number;
  full_name: string;
  is_private: boolean;
  is_fork: boolean;
  status: 'active' | 'completed' | 'unlinked';
  linked_by: string;
  unlink_reason: string | null;
}

export interface DeliveryRow {
  delivery_id: string;
  event: string;
  action: string | null;
  installation_id: string | number | null;
  repository_id: string | number | null;
  payload: unknown;
  status: 'received' | 'processed' | 'ignored' | 'failed';
  attempts: number;
}

export interface GhItemRow {
  repository_id: string | number;
  kind: 'issue' | 'pr';
  number: number;
  title: string;
  author_github_id: string | number | null;
  assignee_github_ids: (string | number)[];
  state: string;
  merged: boolean;
  labels: string[];
  additions: number | null;
  deletions: number | null;
  source_updated_at: Date;
}

export interface ContributionRow {
  id: string;
  team_id: string;
  user_id: string;
  source: 'issue' | 'pr' | 'artifact' | 'ritual';
  ref: string;
  title: string;
  role_code: string;
  role_locked: boolean;
  stage_ordinal: number | null;
  active: boolean;
  occurred_at: Date;
  received_at: Date;
}

export interface CompletionRow {
  team_id: string;
  completed_at: Date;
  planned_end_at: Date;
  overdue_days: number;
  snapshot: Record<string, unknown>;
  completed_by: string;
}

export const grantRows = (world: World, installationId: number): Promise<GrantRow[]> =>
  world.sql<GrantRow[]>`
    SELECT * FROM github.installation_grant WHERE installation_id = ${installationId}
     ORDER BY granted_at`;

export const activeGrantCount = (world: World, teamId: string): Promise<number> =>
  countOf(world.sql<{ n: number }[]>`
    SELECT count(*)::int AS n FROM github.installation_grant
     WHERE team_id = ${teamId} AND revoked_at IS NULL`);

export const repoLinkRows = (world: World, teamId: string): Promise<RepoLinkRow[]> =>
  world.sql<RepoLinkRow[]>`
    SELECT * FROM github.repo_link WHERE team_id = ${teamId} ORDER BY linked_at`;

/** Links of a repository that hold the repository (`repo_link_repository_uq`: active or completed). */
export const holdingLinkCount = (world: World, repositoryId: number): Promise<number> =>
  countOf(world.sql<{ n: number }[]>`
    SELECT count(*)::int AS n FROM github.repo_link
     WHERE repository_id = ${repositoryId} AND status IN ('active', 'completed')`);

export const activeLinkCount = (world: World, teamId: string): Promise<number> =>
  countOf(world.sql<{ n: number }[]>`
    SELECT count(*)::int AS n FROM github.repo_link WHERE team_id = ${teamId} AND status = 'active'`);

export const deliveryRows = (world: World, deliveryId: string): Promise<DeliveryRow[]> =>
  world.sql<DeliveryRow[]>`SELECT * FROM github.webhook_delivery WHERE delivery_id = ${deliveryId}`;

export const deliveryCount = (world: World, deliveryId: string): Promise<number> =>
  countOf(world.sql<{ n: number }[]>`
    SELECT count(*)::int AS n FROM github.webhook_delivery WHERE delivery_id = ${deliveryId}`);

export const ghItemRows = (world: World, repositoryId: number): Promise<GhItemRow[]> =>
  world.sql<GhItemRow[]>`
    SELECT * FROM github.gh_item WHERE repository_id = ${repositoryId} ORDER BY kind, number`;

export const prReviewCount = (world: World, repositoryId: number): Promise<number> =>
  countOf(world.sql<{ n: number }[]>`
    SELECT count(*)::int AS n FROM github.gh_pr_review WHERE repository_id = ${repositoryId}`);

export const contributionRows = (world: World, teamId: string): Promise<ContributionRow[]> =>
  world.sql<ContributionRow[]>`
    SELECT * FROM workspace.contribution WHERE team_id = ${teamId} ORDER BY received_at, ref`;

export const contributionCount = (
  world: World,
  teamId: string,
  filter: { source?: string; ref?: string; userId?: string; active?: boolean } = {},
): Promise<number> =>
  countOf(world.sql<{ n: number }[]>`
    SELECT count(*)::int AS n FROM workspace.contribution
     WHERE team_id = ${teamId}
       AND (${filter.source ?? null}::text IS NULL OR source = ${filter.source ?? null})
       AND (${filter.ref ?? null}::text IS NULL OR ref = ${filter.ref ?? null})
       AND (${filter.userId ?? null}::uuid IS NULL OR user_id = ${filter.userId ?? null})
       AND (${filter.active ?? null}::boolean IS NULL OR active = ${filter.active ?? null})`);

/** Every contribution of every team that carries this ref (a webhook must never leak into a foreign team). */
export const contributionsByRef = (world: World, ref: string): Promise<ContributionRow[]> =>
  world.sql<ContributionRow[]>`SELECT * FROM workspace.contribution WHERE ref = ${ref}`;

export const completionRows = (world: World, teamId: string): Promise<CompletionRow[]> =>
  world.sql<CompletionRow[]>`SELECT * FROM workspace.project_completion WHERE team_id = ${teamId}`;

export const completionCount = (world: World, teamId: string): Promise<number> =>
  countOf(world.sql<{ n: number }[]>`
    SELECT count(*)::int AS n FROM workspace.project_completion WHERE team_id = ${teamId}`);

/**
 * Removes the completion record of a test team. The table refuses UPDATE and DELETE (CC-13), so the
 * owner of the schema switches the guard off for one transaction: tests that plant a "completed project"
 * by hand take it back with this and nothing else.
 */
export async function forgetCompletion(world: World, teamId: string): Promise<void> {
  await world.sql.begin(async (tx) => {
    await tx.unsafe(
      'ALTER TABLE workspace.project_completion DISABLE TRIGGER project_completion_immutable_trg',
    );
    await tx`DELETE FROM workspace.project_completion WHERE team_id = ${teamId}`;
    await tx.unsafe(
      'ALTER TABLE workspace.project_completion ENABLE TRIGGER project_completion_immutable_trg',
    );
  });
}

export const completionCheckCount = (world: World, teamId: string): Promise<number> =>
  countOf(world.sql<{ n: number }[]>`
    SELECT count(*)::int AS n FROM workspace.completion_check WHERE team_id = ${teamId}`);

export const repoCheckRows = (
  world: World,
  teamId: string,
): Promise<{ kind: string; ok: boolean; details: Record<string, unknown> }[]> =>
  world.sql<{ kind: string; ok: boolean; details: Record<string, unknown> }[]>`
    SELECT kind, ok, details FROM github.repo_check WHERE team_id = ${teamId}
     ORDER BY checked_at DESC`;

export interface SyncStateRowDto {
  issues_etag: string | null;
  ci_state: string | null;
  last_synced_at: Date | null;
  issues_resume_page: number | null;
  pulls_resume_page: number | null;
  pending_sync_started_at: Date | null;
}

export const syncStateRow = async (
  world: World,
  repositoryId: number,
): Promise<SyncStateRowDto | undefined> => {
  const rows = await world.sql<SyncStateRowDto[]>`
    SELECT issues_etag, ci_state, last_synced_at, issues_resume_page, pulls_resume_page,
           pending_sync_started_at
      FROM github.repo_sync_state WHERE repository_id = ${repositoryId}`;
  return rows[0];
};

export const accountCheckRow = async (
  world: World,
  githubUserId: number,
): Promise<
  { account_created_at: Date; public_repos: number; has_public_activity: boolean } | undefined
> => {
  const rows = await world.sql<
    { account_created_at: Date; public_repos: number; has_public_activity: boolean }[]
  >`SELECT account_created_at, public_repos, has_public_activity FROM github.account_check
     WHERE github_user_id = ${githubUserId}`;
  return rows[0];
};

export const teamReleaseUrl = async (world: World, teamId: string): Promise<string | null> => {
  const rows = await world.sql<{ release_url: string | null }[]>`
    SELECT release_url FROM teams.team WHERE id = ${teamId}`;
  return rows[0]?.release_url ?? null;
};

export const outboxCount = (world: World, type: string, aggregateId: string): Promise<number> =>
  countOf(world.sql<{ n: number }[]>`
    SELECT count(*)::int AS n FROM platform.outbox_event
     WHERE type = ${type} AND aggregate_id = ${aggregateId}`);
