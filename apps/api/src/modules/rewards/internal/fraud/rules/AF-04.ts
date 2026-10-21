import { contributionTooLow, contributorsTooFew } from '../../../../workspace/public.js';
import type { FraudFacts, Signal } from './facts.js';
import { block } from './signal.js';
import { toCompletionFacts } from './workspace-facts.js';

export const RULE_CODE = 'AF-04';

/**
 * AF-04: at least 10 merged pull requests and closed issues (distinct `ref` of active contributions) from at
 * least 2 accounts. The very conditions of the completion (workspace), here recorded as a block.
 */
export function evaluate(facts: FraudFacts): Signal[] {
  const completion = toCompletionFacts(facts);
  const low = contributionTooLow(completion);
  const few = contributorsTooFew(completion);
  if (low === undefined && few === undefined) return [];
  return [block(RULE_CODE, { ...low?.data, ...few?.data })];
}
