import type { FraudFacts, Signal } from './facts.js';
import { flag } from './signal.js';
import { CREDIT_GAP_DAYS, MIN_SCORE_FOR_LIMIT } from './thresholds.js';

export const RULE_CODE = 'AF-22';

/**
 * AF-22 (Р-13): with a sum of signals of 2 or more, at most one credited project per person in 14 days. A flag of
 * the phase `cooling_end` (manual review, not a refusal); `facts.scoreSoFar` is the score of the other rules.
 */
export function evaluate(facts: FraudFacts): Signal[] {
  if (facts.phase !== 'cooling_end' || facts.scoreSoFar < MIN_SCORE_FOR_LIMIT) return [];
  const userIds = facts.members
    .filter((m) => m.lastOtherCreditDaysAgo !== null && m.lastOtherCreditDaysAgo < CREDIT_GAP_DAYS)
    .map((m) => m.userId);
  if (userIds.length === 0) return [];
  return [flag(RULE_CODE, { userIds, score: facts.scoreSoFar })];
}
