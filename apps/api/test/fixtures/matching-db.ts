import { countOf } from './assertions.js';
import type { World } from './world.js';

/**
 * SQL read-backs for slice 4 invariants. Table and column names are those of docs/architecture.md
 * 5.6 (matching schema) and 5.5 (teams.membership); a mismatch means the migration (S4-02) deviates.
 */

export interface ApplicationRow {
  id: string;
  user_id: string;
  status: 'active' | 'fulfilled' | 'cancelled';
  enqueued_at: Date;
  paused_seconds: number;
  fulfilled_at: Date | null;
  fulfilled_seat_id: string | null;
  fulfilled_role_code: string | null;
  fulfilled_team_id: string | null;
  cancelled_at: Date | null;
  version: number;
}

export const applicationsOf = (world: World, userId: string): Promise<ApplicationRow[]> =>
  world.sql<ApplicationRow[]>`
    SELECT id, user_id, status, enqueued_at, paused_seconds, fulfilled_at, fulfilled_seat_id,
           fulfilled_role_code, fulfilled_team_id, cancelled_at, version
      FROM matching.search_application WHERE user_id = ${userId} ORDER BY enqueued_at, id`;

export const applicationRow = async (
  world: World,
  applicationId: string,
): Promise<ApplicationRow> => {
  const rows = await world.sql<ApplicationRow[]>`
    SELECT id, user_id, status, enqueued_at, paused_seconds, fulfilled_at, fulfilled_seat_id,
           fulfilled_role_code, fulfilled_team_id, cancelled_at, version
      FROM matching.search_application WHERE id = ${applicationId}`;
  const row = rows[0];
  if (!row) throw new Error(`no matching.search_application ${applicationId}`);
  return row;
};

export const activeApplications = (world: World, userId: string): Promise<number> =>
  countOf(world.sql<{ n: number }[]>`
    SELECT count(*)::int AS n FROM matching.search_application
     WHERE user_id = ${userId} AND status = 'active'`);

export const fulfilledApplications = (world: World, userId: string): Promise<number> =>
  countOf(world.sql<{ n: number }[]>`
    SELECT count(*)::int AS n FROM matching.search_application
     WHERE user_id = ${userId} AND status = 'fulfilled'`);

export const applicationRoles = (
  world: World,
  applicationId: string,
): Promise<{ role_code: string; priority: number; added_at: Date; is_active: boolean }[]> =>
  world.sql`
    SELECT role_code, priority, added_at, is_active FROM matching.application_role
     WHERE application_id = ${applicationId} ORDER BY priority`;

export const waitSamples = (
  world: World,
  applicationId: string,
): Promise<{ role_code: string; waited_seconds: number; matched_at: Date }[]> =>
  world.sql`
    SELECT role_code, waited_seconds, matched_at FROM matching.wait_sample
     WHERE application_id = ${applicationId} ORDER BY matched_at`;

export const autoAddOutcomes = (
  world: World,
  applicationId: string,
): Promise<{ seat_id: string; outcome: string; reason: string | null }[]> =>
  world.sql`
    SELECT seat_id, outcome, reason FROM matching.auto_add_log
     WHERE application_id = ${applicationId} ORDER BY at`;

export const exclusionTeams = async (world: World, applicationId: string): Promise<string[]> =>
  (
    await world.sql<{ team_id: string }[]>`
      SELECT team_id FROM matching.application_exclusion WHERE application_id = ${applicationId}`
  ).map((row) => row.team_id);

export interface MembershipRow {
  id: string;
  status: 'active' | 'left' | 'removed';
  joined_via: string;
  joined_at: Date;
  trial_until: Date | null;
  trial_confirmed_at: Date | null;
  application_id: string | null;
  left_at: Date | null;
  left_reason: string | null;
}

export async function membershipRow(
  world: World,
  teamId: string,
  userId: string,
): Promise<MembershipRow | undefined> {
  const rows = await world.sql<MembershipRow[]>`
    SELECT id, status, joined_via, joined_at, trial_until, trial_confirmed_at, application_id,
           left_at, left_reason
      FROM teams.membership WHERE team_id = ${teamId} AND user_id = ${userId}
     ORDER BY joined_at DESC LIMIT 1`;
  return rows[0];
}

/** Seats of `teamId` that currently have an active assignment. */
export const filledSeatsOf = (world: World, teamId: string): Promise<number> =>
  countOf(world.sql<{ n: number }[]>`
    SELECT count(*)::int AS n FROM teams.seat_assignment WHERE team_id = ${teamId} AND ended_at IS NULL`);

export async function assignmentDeficit(
  world: World,
  seatId: string,
): Promise<{ deficit_at_join: boolean; deficit_open_seats: number; deficit_queued: number }> {
  const rows = await world.sql<
    { deficit_at_join: boolean; deficit_open_seats: number; deficit_queued: number }[]
  >`
    SELECT deficit_at_join, deficit_open_seats, deficit_queued FROM teams.seat_assignment
     WHERE seat_id = ${seatId} ORDER BY started_at DESC LIMIT 1`;
  const row = rows[0];
  if (!row) throw new Error(`no seat_assignment for seat ${seatId}`);
  return row;
}

/** Count of `match_candidate` rows of a seat (FR-MATCH-01 precomputed table). */
export const matchRowsOfSeat = (world: World, seatId: string): Promise<number> =>
  countOf(world.sql<{ n: number }[]>`
    SELECT count(*)::int AS n FROM matching.match_candidate WHERE seat_id = ${seatId}`);
