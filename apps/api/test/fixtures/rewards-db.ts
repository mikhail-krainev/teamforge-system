import { countOf } from './assertions.js';
import type { World } from './world.js';

/**
 * SQL readers for the `rewards` tables (docs/architecture.md 5.9; S7-02). Tests read the stored state with them
 * and compare it with what the API answers. The columns are those of the architecture; if the migration of S7-02
 * names one differently, only this file changes.
 */

export interface CreditRunRow {
  team_id: string;
  completed_at: Date;
  cooling_until: Date;
  status: 'cooling' | 'frozen' | 'credited' | 'revoked';
  roster_hash: Buffer;
  fraud_score: number;
  credited_at: Date | null;
  version: number;
}

export interface ProjectCreditRow {
  team_id: string;
  user_id: string;
  status: 'credited' | 'pending_account' | 'denied' | 'revoked';
  reason: string | null;
  product_type_code: string;
  overdue_days: number;
  completed_at: Date;
  roster_hash: Buffer;
}

export interface CreditRow {
  team_id: string;
  user_id: string;
  role_code: string;
  status: 'credited' | 'pending_account' | 'denied' | 'revoked';
  deficit_at_join: boolean;
  credited_at: Date | null;
}

export interface AwardRow {
  id: string;
  user_id: string;
  badge_code: string;
  scope: 'individual' | 'team';
  team_id: string | null;
  awarded_at: Date;
  revoked_at: Date | null;
  revoke_reason: string | null;
}

export interface FraudSignalRow {
  team_id: string;
  phase: 'completion' | 'cooling_end' | 'step_check';
  rule_code: string;
  action: 'block' | 'flag' | 'signal' | 'info';
  score: number;
  data: Record<string, unknown>;
}

export interface FraudCaseRow {
  id: string;
  team_id: string;
  status: 'open' | 'ok' | 'violation';
  opened_at: Date;
  decided_by: string | null;
  decided_at: Date | null;
  comment: string | null;
}

export interface AuditRow {
  id: string;
  actor_user_id: string;
  action: string;
  target_type: string;
  target_id: string;
  reason: string;
  data: Record<string, unknown>;
  at: Date;
}

export async function creditRunRow(world: World, teamId: string): Promise<CreditRunRow | undefined> {
  const rows = await world.sql<CreditRunRow[]>`SELECT * FROM rewards.credit_run WHERE team_id = ${teamId}`;
  return rows[0];
}

export const creditRunCount = (world: World, teamId: string): Promise<number> =>
  countOf(world.sql<{ n: number }[]>`SELECT count(*)::int AS n FROM rewards.credit_run WHERE team_id = ${teamId}`);

export const projectCreditRows = (world: World, teamId: string): Promise<ProjectCreditRow[]> =>
  world.sql<ProjectCreditRow[]>`SELECT * FROM rewards.project_credit WHERE team_id = ${teamId} ORDER BY user_id`;

export const projectCreditOf = async (
  world: World,
  teamId: string,
  userId: string,
): Promise<ProjectCreditRow | undefined> =>
  (await projectCreditRows(world, teamId)).find((r) => r.user_id === userId);

export const creditRows = (world: World, teamId: string): Promise<CreditRow[]> =>
  world.sql<CreditRow[]>`SELECT * FROM rewards.credit WHERE team_id = ${teamId} ORDER BY user_id, role_code`;

export const creditsOf = async (world: World, teamId: string, userId: string): Promise<CreditRow[]> =>
  (await creditRows(world, teamId)).filter((r) => r.user_id === userId);

/** The counter of a user: `roleCode` undefined = the total; absent row = 0. */
export async function counterValue(world: World, userId: string, roleCode?: string): Promise<number> {
  const rows = await world.sql<{ value: number }[]>`
    SELECT value FROM rewards.counter
     WHERE user_id = ${userId} AND role_code IS NOT DISTINCT FROM ${roleCode ?? null}`;
  return rows[0]?.value ?? 0;
}

export const counterRowCount = (world: World, userId: string): Promise<number> =>
  countOf(world.sql<{ n: number }[]>`SELECT count(*)::int AS n FROM rewards.counter WHERE user_id = ${userId}`);

export const awardRows = (world: World, userId: string): Promise<AwardRow[]> =>
  world.sql<AwardRow[]>`SELECT * FROM rewards.award WHERE user_id = ${userId} ORDER BY awarded_at, badge_code`;

export const teamAwardRows = (world: World, teamId: string): Promise<AwardRow[]> =>
  world.sql<AwardRow[]>`SELECT * FROM rewards.award WHERE team_id = ${teamId} ORDER BY user_id, badge_code`;

/** Active (not revoked) awards with the name of the badge definition. */
export async function activeAwardNames(world: World, userId: string): Promise<string[]> {
  const rows = await world.sql<{ name: string }[]>`
    SELECT d.name FROM rewards.award a JOIN rewards.badge_def d ON d.code = a.badge_code
     WHERE a.user_id = ${userId} AND a.revoked_at IS NULL ORDER BY d.name`;
  return rows.map((r) => r.name);
}

export const fraudSignalRows = (world: World, teamId: string): Promise<FraudSignalRow[]> =>
  world.sql<FraudSignalRow[]>`SELECT * FROM rewards.fraud_signal WHERE team_id = ${teamId} ORDER BY phase, rule_code`;

export const fraudCaseRows = (world: World, teamId: string): Promise<FraudCaseRow[]> =>
  world.sql<FraudCaseRow[]>`SELECT * FROM rewards.fraud_case WHERE team_id = ${teamId} ORDER BY opened_at`;

export const disputeCount = (world: World, teamId: string): Promise<number> =>
  countOf(world.sql<{ n: number }[]>`SELECT count(*)::int AS n FROM rewards.dispute WHERE team_id = ${teamId}`);

export const auditRows = (world: World, targetId: string): Promise<AuditRow[]> =>
  world.sql<AuditRow[]>`SELECT * FROM rewards.admin_audit WHERE target_id = ${targetId} ORDER BY at`;

export const rewardsOutbox = (world: World, type: string): Promise<number> =>
  countOf(world.sql<{ n: number }[]>`
    SELECT count(*)::int AS n FROM platform.outbox_event WHERE module = 'rewards' AND type = ${type}`);

/** Every counter of the user equals the number of credited rows behind it (the invariant of CC-6 / CC-12). */
export async function countersAgreeWithCredits(world: World, userId: string): Promise<boolean> {
  const [total] = await world.sql<{ counter: number; credited: number }[]>`
    SELECT COALESCE((SELECT value FROM rewards.counter WHERE user_id = ${userId} AND role_code IS NULL), 0)::int AS counter,
           (SELECT count(*) FROM rewards.project_credit WHERE user_id = ${userId} AND status = 'credited')::int AS credited`;
  const perRole = await world.sql<{ role_code: string; counter: number; credited: number }[]>`
    SELECT c.role_code, c.value AS counter,
           (SELECT count(*) FROM rewards.credit x WHERE x.user_id = c.user_id AND x.role_code = c.role_code AND x.status = 'credited')::int AS credited
      FROM rewards.counter c WHERE c.user_id = ${userId} AND c.role_code IS NOT NULL`;
  return total?.counter === total?.credited && perRole.every((r) => r.counter === r.credited);
}
