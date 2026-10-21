import type { FraudFacts, Signal } from './facts.js';
import { flag, scored } from './signal.js';
import { MIN_ROSTER, ROSTER_FLAG_PROJECTS, ROSTER_SIGNAL_PROJECTS, SCORE } from './thresholds.js';

export const RULE_CODE = 'AF-13';

/**
 * AF-13: the same three or more people completed projects together and nobody else: the second project +1,
 * the third and further a flag. A roster of two is not a circle.
 */
export function evaluate(facts: FraudFacts): Signal[] {
  const projects = facts.sameRosterProjects;
  if (facts.members.length < MIN_ROSTER) return [];
  const data = { projects, members: facts.members.length };
  if (projects >= ROSTER_FLAG_PROJECTS) return [flag(RULE_CODE, data)];
  if (projects >= ROSTER_SIGNAL_PROJECTS) return [scored(RULE_CODE, SCORE.AF13, data)];
  return [];
}
