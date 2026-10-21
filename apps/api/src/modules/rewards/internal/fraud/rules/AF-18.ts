import type { FraudFacts, MemberFacts, Signal } from './facts.js';
import { scored } from './signal.js';
import { SCORE } from './thresholds.js';

export const RULE_CODE = 'AF-18';

/** Another account, member or not, holds the same normalised profile or resume text. */
function sharesText(member: MemberFacts, holders: Record<string, string[]>): boolean {
  if (member.textHash === null) return false;
  return (holders[member.textHash] ?? []).some((holder) => holder !== member.userId);
}

/** AF-18: identical profile or resume text (normalised hash) in different accounts: +2. */
export function evaluate(facts: FraudFacts): Signal[] {
  const userIds = facts.members
    .filter((m) => sharesText(m, facts.textHolders))
    .map((m) => m.userId);
  if (userIds.length === 0) return [];
  return [scored(RULE_CODE, SCORE.AF18, { userIds })];
}
