import type { FraudFacts, IdentitySignalFacts, Signal } from './facts.js';
import { scored } from './signal.js';
import { SCORE, SHARED_GROUP, SHARED_PAIR } from './thresholds.js';

export const RULE_CODE = 'AF-17';

/**
 * The kinds that count on their own. A user agent is shared by every colleague with the same browser and system
 * (M-3), so alone it is no link: it counts only together with another feature, in AF-21.
 */
const KINDS: readonly IdentitySignalFacts['kind'][] = ['ip24', 'device'];

interface Group {
  kind: IdentitySignalFacts['kind'];
  userIds: string[];
}

/** The members that share one value of `kind`, the largest group (a member is counted once per value). */
function largestGroup(facts: FraudFacts, kind: IdentitySignalFacts['kind']): Group {
  const members = new Set(facts.members.map((m) => m.userId));
  const byValue = new Map<string, Set<string>>();
  for (const s of facts.identitySignals) {
    if (s.kind !== kind || !members.has(s.userId)) continue;
    byValue.set(s.valueHmac, (byValue.get(s.valueHmac) ?? new Set<string>()).add(s.userId));
  }
  const groups = [...byValue.values()].map((users) => [...users]);
  const best = groups.reduce<string[]>((a, b) => (b.length > a.length ? b : a), []);
  return { kind, userIds: best };
}

const scoreOfSize = (size: number): number => {
  if (size >= SHARED_GROUP) return SCORE.AF17_GROUP;
  return size >= SHARED_PAIR ? SCORE.AF17_PAIR : 0;
};

/**
 * AF-17: a shared subnet or device between members: two members +1, three or more +2; the highest
 * over the kinds. The data hold the kind and the user ids, never the HMAC.
 */
export function evaluate(facts: FraudFacts): Signal[] {
  const groups = KINDS.map((kind) => largestGroup(facts, kind));
  const top = groups.reduce((a, b) => (b.userIds.length > a.userIds.length ? b : a));
  const score = scoreOfSize(top.userIds.length);
  if (score === 0) return [];
  return [scored(RULE_CODE, score, { kind: top.kind, userIds: top.userIds })];
}
