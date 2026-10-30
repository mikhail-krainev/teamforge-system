import type { FraudFacts, Signal, StageFacts } from './facts.js';
import { flag } from './signal.js';
import { DAY_MS, HOUR_MS, MIN_PLAN_SHARE, MIN_TEAM_AGE_HOURS } from './thresholds.js';

export const RULE_CODE = 'AF-11';

/** Share of the planned length that the stages actually took (first opening to last closing); `null` = unknown. */
function planShare(stages: readonly StageFacts[]): number | null {
  const planned = stages.reduce((sum, s) => sum + s.plannedDays, 0) * DAY_MS;
  const opened = stages.map((s) => s.openedAt?.getTime());
  const closed = stages.map((s) => s.closedAt?.getTime());
  const complete = (t: number | undefined): t is number => t !== undefined;
  if (planned <= 0 || !opened.every(complete) || !closed.every(complete)) return null;
  return (Math.max(...closed) - Math.min(...opened)) / planned;
}

/**
 * AF-11: completed within 24 hours of the creation of the team, or all stages closed in less than 20 % of their
 * planned length. One flag for both conditions.
 */
export function evaluate(facts: FraudFacts): Signal[] {
  const teamAgeMs = facts.team.completedAt.getTime() - facts.team.createdAt.getTime();
  const quickTeam = teamAgeMs < MIN_TEAM_AGE_HOURS * HOUR_MS;
  const share = facts.stages.length === 0 ? null : planShare(facts.stages);
  const compressed = share !== null && share < MIN_PLAN_SHARE;
  if (!quickTeam && !compressed) return [];
  return [
    flag(RULE_CODE, {
      teamAgeHours: Math.floor(teamAgeMs / HOUR_MS),
      planShare: share,
      quickTeam,
      compressed,
    }),
  ];
}
