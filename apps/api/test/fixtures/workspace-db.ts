import type { World } from './world.js';

/**
 * SQL readers and writers for the `workspace` tables of docs/architecture.md 5.7 (slice 5). Tests read
 * the stored state with them and, where a scenario needs a state that is slow to reach through the
 * API (a nearly full project quota), write it directly - the same rule as the other `*-db.ts` fixtures.
 */

export interface StageRow {
  id: string;
  team_id: string;
  stage_key: string;
  ordinal: number;
  status: 'pending' | 'open' | 'closed';
  opened_at: Date | null;
  due_at: Date | null;
  closed_at: Date | null;
  closed_by: string | null;
  duration_days: number;
  version: number;
}

export interface ItemRow {
  id: string;
  team_id: string;
  project_stage_id: string;
  step_key: string;
  status: 'open' | 'done';
  assignee_user_id: string | null;
  role_code: string | null;
  fallback_used: boolean;
  link_url: string | null;
  link_status: 'none' | 'unchecked' | 'ok' | 'broken' | 'rejected';
  version: number;
  done_by: string | null;
}

export interface FileRow {
  id: string;
  team_id: string;
  checklist_item_id: string;
  storage_key: string;
  size_bytes: number;
  mime: string;
  original_name: string;
  uploaded_by: string;
  deleted_at: Date | null;
}

export interface UsageRow {
  team_id: string;
  files_count: number;
  bytes_total: string | number;
}

export function stageRows(world: World, teamId: string): Promise<StageRow[]> {
  return world.sql<StageRow[]>`
    SELECT * FROM workspace.project_stage WHERE team_id = ${teamId} ORDER BY ordinal`;
}

export async function openStageCount(world: World, teamId: string): Promise<number> {
  const rows = await world.sql<{ n: number }[]>`
    SELECT count(*)::int AS n FROM workspace.project_stage
     WHERE team_id = ${teamId} AND status = 'open'`;
  return rows[0]?.n ?? Number.NaN;
}

export function itemRows(world: World, teamId: string, ordinal?: number): Promise<ItemRow[]> {
  return ordinal === undefined
    ? world.sql<ItemRow[]>`
        SELECT * FROM workspace.checklist_item WHERE team_id = ${teamId} ORDER BY step_key`
    : world.sql<ItemRow[]>`
        SELECT i.* FROM workspace.checklist_item i
          JOIN workspace.project_stage s ON s.id = i.project_stage_id
         WHERE i.team_id = ${teamId} AND s.ordinal = ${ordinal} ORDER BY i.step_key`;
}

export async function itemRow(world: World, itemId: string): Promise<ItemRow> {
  const rows = await world.sql<
    ItemRow[]
  >`SELECT * FROM workspace.checklist_item WHERE id = ${itemId}`;
  const row = rows[0];
  if (!row) throw new Error(`no checklist item ${itemId}`);
  return row;
}

export function fileRows(world: World, itemId: string): Promise<FileRow[]> {
  return world.sql<FileRow[]>`
    SELECT * FROM workspace.artifact_file
     WHERE checklist_item_id = ${itemId} AND deleted_at IS NULL ORDER BY created_at`;
}

export async function activeFilesOfTeam(world: World, teamId: string): Promise<number> {
  const rows = await world.sql<{ n: number }[]>`
    SELECT count(*)::int AS n FROM workspace.artifact_file
     WHERE team_id = ${teamId} AND deleted_at IS NULL`;
  return rows[0]?.n ?? Number.NaN;
}

export async function usageRow(world: World, teamId: string): Promise<UsageRow | undefined> {
  const rows = await world.sql<UsageRow[]>`
    SELECT team_id, files_count, bytes_total FROM workspace.project_storage_usage
     WHERE team_id = ${teamId}`;
  return rows[0];
}

export async function usageOf(
  world: World,
  teamId: string,
): Promise<{ files: number; bytes: number }> {
  const row = await usageRow(world, teamId);
  return { files: Number(row?.files_count ?? 0), bytes: Number(row?.bytes_total ?? 0) };
}

/** Sets the quota counters of a project (C-48, C-49) without uploading dozens of files. */
export async function setUsage(
  world: World,
  teamId: string,
  usage: { files: number; bytes: number },
): Promise<void> {
  await world.sql`
    INSERT INTO workspace.project_storage_usage (team_id, files_count, bytes_total)
    VALUES (${teamId}, ${usage.files}, ${usage.bytes})
    ON CONFLICT (team_id) DO UPDATE
       SET files_count = EXCLUDED.files_count, bytes_total = EXCLUDED.bytes_total`;
}

export async function reviewAnswerCount(world: World, itemId: string): Promise<number> {
  const rows = await world.sql<{ n: number }[]>`
    SELECT count(*)::int AS n FROM workspace.review_answer WHERE checklist_item_id = ${itemId}`;
  return rows[0]?.n ?? Number.NaN;
}

export async function riskCount(world: World, itemId: string): Promise<number> {
  const rows = await world.sql<{ n: number }[]>`
    SELECT count(*)::int AS n FROM workspace.review_risk WHERE checklist_item_id = ${itemId}`;
  return rows[0]?.n ?? Number.NaN;
}

export async function participationCount(
  world: World,
  teamId: string,
  userId: string,
): Promise<number> {
  const rows = await world.sql<{ n: number }[]>`
    SELECT count(*)::int AS n FROM workspace.participation_confirm
     WHERE team_id = ${teamId} AND user_id = ${userId}`;
  return rows[0]?.n ?? Number.NaN;
}
