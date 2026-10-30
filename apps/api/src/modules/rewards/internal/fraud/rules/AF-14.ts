import type { FraudFacts, Signal } from './facts.js';
import { scored } from './signal.js';
import { DAY_MS, DESIRED_MARK_DAYS, SCORE } from './thresholds.js';

export const RULE_CODE = 'AF-14';

/**
 * AF-14 (C-17): the mark "желательная" was set less than 7 days before the completion: +1. It is a signal only,
 * the bonus is not cancelled automatically (FR-REW-10).
 */
export function evaluate(facts: FraudFacts): Signal[] {
  const completed = facts.team.completedAt.getTime();
  const fresh = facts.desiredMarks.filter(
    (m) => completed - m.changedAt.getTime() < DESIRED_MARK_DAYS * DAY_MS,
  );
  if (fresh.length === 0) return [];
  return [scored(RULE_CODE, SCORE.AF14, { roleCodes: fresh.map((m) => m.roleCode) })];
}
