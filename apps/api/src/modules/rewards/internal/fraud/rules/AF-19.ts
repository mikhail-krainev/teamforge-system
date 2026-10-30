import type { FraudFacts, MemberFacts, Signal } from './facts.js';
import { scored } from './signal.js';
import { CLOSE_MINUTES, MINUTE_MS, SCORE } from './thresholds.js';

export const RULE_CODE = 'AF-19';

/** The ids of the members whose `field` times follow each other within 10 minutes (sorted by time). */
function closeBy(members: readonly MemberFacts[], field: 'registeredAt' | 'joinedAt'): string[] {
  const sorted = [...members].sort((a, b) => a[field].getTime() - b[field].getTime());
  const close = new Set<string>();
  sorted.forEach((member, i) => {
    const next = sorted[i + 1];
    if (next === undefined) return;
    if (next[field].getTime() - member[field].getTime() <= CLOSE_MINUTES * MINUTE_MS) {
      close.add(member.userId).add(next.userId);
    }
  });
  return [...close];
}

/** AF-19: two accounts registered, or joined the team, within 10 minutes of each other: +1 (one signal). */
export function evaluate(facts: FraudFacts): Signal[] {
  const registered = closeBy(facts.members, 'registeredAt');
  const joined = closeBy(facts.members, 'joinedAt');
  if (registered.length === 0 && joined.length === 0) return [];
  return [scored(RULE_CODE, SCORE.AF19, { registered, joined })];
}
