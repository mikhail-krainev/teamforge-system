import type { FraudFacts, Signal } from './facts.js';
import { flag } from './signal.js';
import { DAY_MS, REPO_AGE_DAYS } from './thresholds.js';

export const RULE_CODE = 'AF-03';

/** AF-03 (C-55): the repository was created more than 30 days before the start of the project: a flag. */
export function evaluate(facts: FraudFacts): Signal[] {
  const ageMs = facts.team.startedAt.getTime() - facts.repository.createdAt.getTime();
  if (ageMs <= REPO_AGE_DAYS * DAY_MS) return [];
  return [
    flag(RULE_CODE, { repositoryId: facts.repository.id, ageDays: Math.floor(ageMs / DAY_MS) }),
  ];
}
