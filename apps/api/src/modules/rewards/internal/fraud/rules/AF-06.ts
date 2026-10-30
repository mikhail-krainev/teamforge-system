import type { FraudFacts, Signal } from './facts.js';
import { flag } from './signal.js';

export const RULE_CODE = 'AF-06';

/** AF-06: the SHA-256 of an artifact file repeats a file of another project, or a file is empty: one flag. */
export function evaluate(facts: FraudFacts): Signal[] {
  const repeated = facts.artifacts.filter((a) => a.sameHashInOtherTeam).length;
  const empty = facts.artifacts.filter((a) => a.sizeBytes === 0).length;
  if (repeated === 0 && empty === 0) return [];
  return [flag(RULE_CODE, { repeated, empty })];
}
