import type { FraudFacts, Signal } from './facts.js';
import { scored } from './signal.js';
import { SCORE } from './thresholds.js';

export const RULE_CODE = 'AF-15';

/**
 * AF-15: the GitHub id or the email of a member matches the tombstone of a deleted account (SEC-13). The block
 * is at the registration (slice 2); here it is a signal that names the members.
 */
export function evaluate(facts: FraudFacts): Signal[] {
  const userIds = facts.members.filter((m) => m.tombstoneMatch).map((m) => m.userId);
  if (userIds.length === 0) return [];
  return [scored(RULE_CODE, SCORE.AF15, { userIds })];
}
