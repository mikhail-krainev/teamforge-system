import { stageClosedTooFast } from '../../../../workspace/public.js';
import type { FraudFacts, Signal, StageFacts } from './facts.js';
import { block } from './signal.js';
import { toCompletionFacts } from './workspace-facts.js';

export const RULE_CODE = 'AF-10';

/** A lower stage was still open, or closed later, when this one was closed. */
function closedBefore(stage: StageFacts, lower: StageFacts): boolean {
  if (lower.status !== 'closed') return true;
  return lower.closedAt !== null && stage.closedAt !== null && lower.closedAt > stage.closedAt;
}

/** Ordinals of the stages closed ahead of a stage with a lower ordinal (the order is broken). */
function outOfOrder(stages: readonly StageFacts[]): number[] {
  const sorted = [...stages].sort((a, b) => a.ordinal - b.ordinal);
  return sorted
    .filter(
      (stage, i) =>
        stage.status === 'closed' && sorted.slice(0, i).some((l) => closedBefore(stage, l)),
    )
    .map((stage) => stage.ordinal);
}

/** AF-10: no stage closed faster than 24 hours after its opening, and the stages are closed in order. */
export function evaluate(facts: FraudFacts): Signal[] {
  const fast = stageClosedTooFast(toCompletionFacts(facts));
  const unordered = outOfOrder(facts.stages);
  if (fast === undefined && unordered.length === 0) return [];
  return [block(RULE_CODE, { ...fast?.data, outOfOrder: unordered })];
}
