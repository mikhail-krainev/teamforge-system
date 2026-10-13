import { expect } from 'vitest';
import { countOf } from './assertions.js';
import type { World } from './world.js';

/**
 * SQL read-backs for slice 3 invariants. Table and column names are those of docs/architecture.md
 * 5.5 (teams schema) and 5.7 (workspace.notification); a mismatch means the migration (S3-02) deviates.
 */

export const activeAssignments = (world: World, seatId: string): Promise<number> =>
  countOf(world.sql<{ n: number }[]>`
    SELECT count(*)::int AS n FROM teams.seat_assignment WHERE seat_id = ${seatId} AND ended_at IS NULL`);

export const activeMemberships = (world: World, teamId: string): Promise<number> =>
  countOf(world.sql<{ n: number }[]>`
    SELECT count(*)::int AS n FROM teams.membership WHERE team_id = ${teamId} AND status = 'active'`);

export const activeMembershipsOf = (world: World, userId: string): Promise<number> =>
  countOf(world.sql<{ n: number }[]>`
    SELECT count(*)::int AS n FROM teams.membership m JOIN teams.team t ON t.id = m.team_id
     WHERE m.user_id = ${userId} AND m.status = 'active'
       AND t.status IN ('forming', 'active', 'voting', 'suspended')`);

export const openVotes = (world: World, teamId: string): Promise<number> =>
  countOf(world.sql<{ n: number }[]>`
    SELECT count(*)::int AS n FROM teams.leader_vote
     WHERE team_id = ${teamId} AND status NOT IN ('closed', 'cancelled')`);

export const eventCount = (world: World, teamId: string, type: string): Promise<number> =>
  countOf(world.sql<{ n: number }[]>`
    SELECT count(*)::int AS n FROM teams.team_event WHERE team_id = ${teamId} AND type = ${type}`);

export const pendingOffers = (world: World, teamId: string): Promise<number> =>
  countOf(world.sql<{ n: number }[]>`
    SELECT count(*)::int AS n FROM teams.seat_offer WHERE team_id = ${teamId} AND status = 'pending'`);

export const activeInvitations = (world: World, teamId: string): Promise<number> =>
  countOf(world.sql<{ n: number }[]>`
    SELECT count(*)::int AS n FROM teams.invitation WHERE team_id = ${teamId} AND status = 'active'`);

export interface TeamRow {
  status: string;
  member_count: number;
  seat_count: number;
  lead_user_id: string | null;
  version: number;
}

export async function teamRow(world: World, teamId: string): Promise<TeamRow> {
  const rows = await world.sql<TeamRow[]>`
    SELECT status, member_count, seat_count, lead_user_id, version FROM teams.team WHERE id = ${teamId}`;
  const row = rows[0];
  if (!row) throw new Error(`no teams.team ${teamId}`);
  return row;
}

export async function seatStatus(world: World, seatId: string): Promise<string | undefined> {
  const rows = await world.sql<{ status: string }[]>`
    SELECT status FROM teams.seat WHERE id = ${seatId}`;
  return rows[0]?.status;
}

export async function invitationRow(
  world: World,
  invitationId: string,
): Promise<{ status: string; token_hash: Buffer; used_by: string | null } | undefined> {
  const rows = await world.sql<{ status: string; token_hash: Buffer; used_by: string | null }[]>`
    SELECT status, token_hash, used_by FROM teams.invitation WHERE id = ${invitationId}`;
  return rows[0];
}

export const notificationCount = (world: World, userId: string): Promise<number> =>
  countOf(world.sql<{ n: number }[]>`
    SELECT count(*)::int AS n FROM workspace.notification WHERE user_id = ${userId}`);

/** No deadlock was reported by PostgreSQL or logged (architecture 12.5). */
export async function expectNoDeadlocks(world: World, before: number): Promise<void> {
  expect(await world.deadlocks()).toBe(before);
  expect(world.logs.filter((line) => line.includes('40P01'))).toEqual([]);
}
