import type { FraudFacts, Signal } from './facts.js';
import { scored } from './signal.js';
import { SCORE } from './thresholds.js';

export const RULE_CODE = 'AF-20';

/**
 * AF-20: one participant has all the contribution and the other members not a single event (an artifact or a
 * ritual is an event too): +2. A project without any event is not "100 % of one member".
 */
export function evaluate(facts: FraudFacts): Signal[] {
  const events = facts.contributions.filter((c) => c.active);
  const contributors = new Set(events.map((c) => c.userId));
  const [only] = [...contributors];
  if (contributors.size !== 1 || only === undefined || facts.members.length < 2) return [];
  return [scored(RULE_CODE, SCORE.AF20, { userId: only, events: events.length })];
}
