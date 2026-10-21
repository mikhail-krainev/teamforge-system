import type { FraudFacts, Signal } from './facts.js';
import { flag } from './signal.js';
import { HOUR_MS, LATE_SHARE, LATE_WINDOW_HOURS } from './thresholds.js';

export const RULE_CODE = 'AF-07';

/**
 * AF-07: more than 70 % of the contribution events fall into the last 48 hours of the project. The window is
 * counted back from the completion of the team, not from now.
 */
export function evaluate(facts: FraudFacts): Signal[] {
  const events = facts.contributions.filter((c) => c.active);
  if (events.length === 0) return [];
  const windowStart = facts.team.completedAt.getTime() - LATE_WINDOW_HOURS * HOUR_MS;
  const late = events.filter((c) => c.receivedAt.getTime() >= windowStart).length;
  if (late / events.length <= LATE_SHARE) return [];
  return [flag(RULE_CODE, { late, total: events.length })];
}
