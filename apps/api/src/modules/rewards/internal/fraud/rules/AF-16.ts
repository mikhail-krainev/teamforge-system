import type { FraudFacts, MemberFacts, Signal } from './facts.js';
import { info } from './signal.js';
import { ACCOUNT_MIN_AGE_DAYS } from './thresholds.js';

export const RULE_CODE = 'AF-16';

/** FR-GH-09: the account is not checked yet, younger than 30 days (C-59) or without public activity. */
const isDeferred = (member: MemberFacts): boolean =>
  member.account === null ||
  member.account.ageDays < ACCOUNT_MIN_AGE_DAYS ||
  !member.account.hasPublicActivity;

/**
 * AF-16: the credit of such members is deferred (`pending_account`): an info row that lists them, with no score;
 * it neither blocks nor freezes the project.
 */
export function evaluate(facts: FraudFacts): Signal[] {
  const userIds = facts.members.filter(isDeferred).map((m) => m.userId);
  if (userIds.length === 0) return [];
  return [info(RULE_CODE, { userIds })];
}
