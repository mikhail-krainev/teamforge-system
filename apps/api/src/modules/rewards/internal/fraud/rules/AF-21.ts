import type { FraudFacts, IdentitySignalFacts, MemberFacts, Signal } from './facts.js';
import { flag } from './signal.js';
import { LINK_FEATURES } from './thresholds.js';

export const RULE_CODE = 'AF-21';

type Kind = IdentitySignalFacts['kind'];
const KINDS: readonly Kind[] = ['ip24', 'ua', 'device'];

/** The values (HMACs) of `kind` that a member has recorded. */
function valuesOf(facts: FraudFacts, userId: string, kind: Kind): Set<string> {
  return new Set(
    facts.identitySignals
      .filter((s) => s.userId === userId && s.kind === kind)
      .map((s) => s.valueHmac),
  );
}

/** How many features two accounts share: a value of each kind (subnet, agent, device) and the profile text. */
function commonFeatures(facts: FraudFacts, a: MemberFacts, b: MemberFacts): number {
  const network = KINDS.filter((kind) => {
    const left = valuesOf(facts, a.userId, kind);
    return [...valuesOf(facts, b.userId, kind)].some((v) => left.has(v));
  }).length;
  const sameText = a.textHash !== null && a.textHash === b.textHash ? 1 : 0;
  return network + sameText;
}

/** AF-21: accounts linked by at least three features in common (a pair, not spread over several): a flag. */
export function evaluate(facts: FraudFacts): Signal[] {
  const pairs: { userIds: string[]; features: number }[] = [];
  facts.members.forEach((a, i) => {
    for (const b of facts.members.slice(i + 1)) {
      const features = commonFeatures(facts, a, b);
      if (features >= LINK_FEATURES) pairs.push({ userIds: [a.userId, b.userId], features });
    }
  });
  if (pairs.length === 0) return [];
  return [flag(RULE_CODE, { pairs })];
}
