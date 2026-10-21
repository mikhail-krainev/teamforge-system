import type { FraudFacts, Signal } from './facts.js';
import { scored } from './signal.js';
import { MINUTE_MS, SCORE, STAGE_BURST_COUNT, STAGE_BURST_MINUTES } from './thresholds.js';

export const RULE_CODE = 'AF-12';

/** AF-12: three or more stages closed within one hour: +1 (not more however many stages are in the burst). */
export function evaluate(facts: FraudFacts): Signal[] {
  const closed = facts.stages
    .flatMap((s) => (s.closedAt === null ? [] : [s.closedAt.getTime()]))
    .sort((a, b) => a - b);
  const window = STAGE_BURST_COUNT - 1;
  const burst = closed.some((time, i) => {
    const last = closed[i + window];
    return last !== undefined && last - time <= STAGE_BURST_MINUTES * MINUTE_MS;
  });
  if (!burst) return [];
  return [scored(RULE_CODE, SCORE.AF12, { stages: closed.length })];
}
