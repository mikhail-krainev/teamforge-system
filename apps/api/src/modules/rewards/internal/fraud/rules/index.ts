import * as af01 from './AF-01.js';
import * as af02 from './AF-02.js';
import * as af03 from './AF-03.js';
import * as af04 from './AF-04.js';
import * as af05 from './AF-05.js';
import * as af06 from './AF-06.js';
import * as af07 from './AF-07.js';
import * as af08 from './AF-08.js';
import * as af09 from './AF-09.js';
import * as af10 from './AF-10.js';
import * as af11 from './AF-11.js';
import * as af12 from './AF-12.js';
import * as af13 from './AF-13.js';
import * as af14 from './AF-14.js';
import * as af15 from './AF-15.js';
import * as af16 from './AF-16.js';
import * as af17 from './AF-17.js';
import * as af18 from './AF-18.js';
import * as af19 from './AF-19.js';
import * as af20 from './AF-20.js';
import * as af21 from './AF-21.js';
import * as af22 from './AF-22.js';
import type { FraudFacts, Phase, Signal } from './facts.js';
import { SCORE_THRESHOLD } from './thresholds.js';

export interface Rule {
  ruleCode: string;
  /** The phases the rule runs in. */
  phases: readonly Phase[];
  evaluate: (facts: FraudFacts) => Signal[];
}

const BOTH: readonly Phase[] = ['completion', 'cooling_end'];

const rule = (
  module: { RULE_CODE: string; evaluate: (facts: FraudFacts) => Signal[] },
  phases: readonly Phase[] = BOTH,
): Rule => ({ ruleCode: module.RULE_CODE, phases, evaluate: module.evaluate });

/** AF-23..AF-25 are processes (server time, cooling, audit), not functions of the facts. */
export const RULES: readonly Rule[] = [
  af01,
  af02,
  af03,
  af04,
  af05,
  af06,
  af07,
  af08,
  af09,
  af10,
  af11,
  af12,
  af13,
  af14,
  af15,
  af16,
  af17,
  af18,
  af19,
  af20,
  af21,
]
  .map((module) => rule(module))
  .concat(rule(af22, ['cooling_end']));

const scoreOf = (signals: readonly Signal[]): number =>
  signals.filter((s) => s.action === 'signal').reduce((sum, s) => sum + s.score, 0);

/**
 * Runs the rules of `facts.phase`: one signal per rule at most, sorted by `ruleCode`. AF-22 reads the sum of the
 * scores of all the other rules of this run (`facts.scoreSoFar` is overridden).
 */
export function evaluateAll(facts: FraudFacts): Signal[] {
  const applicable = RULES.filter((r) => r.phases.includes(facts.phase));
  const dependent = applicable.filter((r) => r.ruleCode === af22.RULE_CODE);
  const independent = applicable.filter((r) => r.ruleCode !== af22.RULE_CODE);
  const first = independent.flatMap((r) => r.evaluate(facts));
  const second = dependent.flatMap((r) => r.evaluate({ ...facts, scoreSoFar: scoreOf(first) }));
  return [...first, ...second].sort((a, b) => (a.ruleCode < b.ruleCode ? -1 : 1));
}

/** FR-REW-15: the score is the sum of the `signal` rows; frozen = any block or flag, or a score >= C-61 (3). */
export function summarize(signals: readonly Signal[]): { score: number; frozen: boolean } {
  const score = scoreOf(signals);
  const stopped = signals.some((s) => s.action === 'block' || s.action === 'flag');
  return { score, frozen: stopped || score >= SCORE_THRESHOLD };
}
