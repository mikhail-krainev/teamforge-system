import { contributionDaysTooFew, durationTooShort } from '../../../../workspace/public.js';
import type { FraudFacts, Signal } from './facts.js';
import { block } from './signal.js';
import { toCompletionFacts } from './workspace-facts.js';

export const RULE_CODE = 'AF-09';

/**
 * AF-09: at least 14 whole days since the first stage opened and contributions on at least 3 calendar days (UTC).
 * The very conditions of the completion (workspace), here recorded as a block.
 */
export function evaluate(facts: FraudFacts): Signal[] {
  const completion = toCompletionFacts(facts);
  const short = durationTooShort(completion);
  const fewDays = contributionDaysTooFew(completion);
  if (short === undefined && fewDays === undefined) return [];
  return [block(RULE_CODE, { ...short?.data, ...fewDays?.data })];
}
