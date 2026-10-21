import type { FraudFacts, Signal } from './facts.js';
import { flag } from './signal.js';
import { MAX_PR_SHARE, MIN_CHANGED_LINES } from './thresholds.js';

export const RULE_CODE = 'AF-05';

/** AF-05: fewer than 200 changed lines in merged pull requests, or one pull request holds more than 80 %. */
export function evaluate(facts: FraudFacts): Signal[] {
  const { changedLines, maxShare } = facts.pullRequests;
  const tooFewLines = changedLines < MIN_CHANGED_LINES;
  const oneBigPr = maxShare > MAX_PR_SHARE;
  if (!tooFewLines && !oneBigPr) return [];
  return [flag(RULE_CODE, { changedLines, maxShare, tooFewLines, oneBigPr })];
}
