import type { FraudFacts, Signal } from './facts.js';
import { normalizeText, scored } from './signal.js';
import { SCORE } from './thresholds.js';

export const RULE_CODE = 'AF-08';

/** AF-08: name and description match (normalised) a project of the same team that is already credited: +1. */
export function evaluate(facts: FraudFacts): Signal[] {
  const name = normalizeText(facts.team.name);
  const description = normalizeText(facts.team.description);
  const matches = facts.earlierProjects.filter(
    (p) => normalizeText(p.name) === name && normalizeText(p.description) === description,
  ).length;
  if (matches === 0) return [];
  return [scored(RULE_CODE, SCORE.AF08, { matches })];
}
