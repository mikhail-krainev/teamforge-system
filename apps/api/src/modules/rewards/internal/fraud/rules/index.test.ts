import { describe, expect, it } from 'vitest';
import {
  at,
  cleanFacts,
  loadRegistry,
  MINUTE_MS,
  USERS,
  type FraudFacts,
  type Signal,
} from '../../../test/fraud-facts.js';
import { summarizeAfterReview } from './index.js';

/*
 * S7-03 (written before the implementation): the registry `rules/index.ts` that runs the rules of a phase and
 * decides whether the project is frozen (FR-REW-15: any flag or block, or a sum of signals >= C-61 = 3;
 * architecture 10.1, 10.5). The result of a phase becomes `credit_run.status`: `cooling` or `frozen`.
 */

const signal = (action: Signal['action'], score: number, ruleCode = 'AF-99'): Signal => ({
  ruleCode,
  action,
  score,
  data: {},
});

/** A project with two scored signals: AF-14 (a fresh mark, +1) and AF-12 (three stages in one hour, +1). */
function twoPoints(phase: FraudFacts['phase']): FraudFacts {
  const facts = cleanFacts({ phase, desiredMarks: [{ roleCode: 'backend', changedAt: at(2) }] });
  const base = facts.stages[0]?.openedAt ?? facts.now;
  // Every stage opens with the first one (a parallel route), so closing three of them within an hour does not
  // also close a stage faster than 24 hours after its opening (AF-10), which would be a block, not two points.
  facts.stages = facts.stages.map((s, i) => ({
    ...s,
    openedAt: base,
    closedAt: new Date(base.getTime() + 20 * 24 * 3_600_000 + i * 10 * MINUTE_MS),
  }));
  facts.members = facts.members.map((m) =>
    m.userId === USERS[1] ? { ...m, lastOtherCreditDaysAgo: 5 } : m,
  );
  return facts;
}

describe('summarize (FR-REW-15, C-61)', () => {
  it('FR-REW-15: no signals -> score 0, not frozen', async () => {
    const { summarize } = await loadRegistry();
    expect(summarize([])).toEqual({ score: 0, frozen: false });
  });

  it('FR-REW-15: the sum of signals below 3 does not freeze: 1 + 1 = 2', async () => {
    const { summarize } = await loadRegistry();
    expect(summarize([signal('signal', 1), signal('signal', 1)])).toEqual({
      score: 2,
      frozen: false,
    });
  });

  it('FR-REW-15: the sum of signals of 3 or more freezes: 1 + 2 = 3', async () => {
    const { summarize } = await loadRegistry();
    expect(summarize([signal('signal', 1), signal('signal', 2)])).toEqual({
      score: 3,
      frozen: true,
    });
  });

  it('FR-REW-15: any flag freezes whatever the score; so does a block', async () => {
    const { summarize } = await loadRegistry();
    expect(summarize([signal('flag', 0)]).frozen).toBe(true);
    expect(summarize([signal('block', 0)]).frozen).toBe(true);
  });

  it('FR-REW-15, AF-16: an info row (deferred credit) has no score and does not freeze', async () => {
    const { summarize } = await loadRegistry();
    expect(summarize([signal('info', 0, 'AF-16')])).toEqual({ score: 0, frozen: false });
  });
});

describe('summarizeAfterReview (S7SEC-01, AF-22, FR-REW-16)', () => {
  it('without a decision "ok" it is the plain summary', () => {
    expect(summarizeAfterReview([signal('flag', 0, 'AF-05')], undefined)).toEqual({
      score: 0,
      frozen: true,
    });
  });

  it('a flag the administrator already reviewed does not freeze the project a second time', () => {
    expect(summarizeAfterReview([signal('flag', 0, 'AF-05')], new Set(['AF-05']))).toEqual({
      score: 0,
      frozen: false,
    });
  });

  it('AF-22: a flag of a rule the review has not seen freezes again', () => {
    const signals = [
      signal('signal', 1, 'AF-17'),
      signal('signal', 1, 'AF-19'),
      signal('flag', 0, 'AF-22'),
    ];
    expect(summarizeAfterReview(signals, new Set(['AF-17', 'AF-19'])).frozen).toBe(true);
  });

  it('C-61: reviewed scores alone do not freeze again; a new scored rule reaching the threshold does', () => {
    const reviewed = new Set(['AF-17', 'AF-20']);
    const old = [signal('signal', 1, 'AF-17'), signal('signal', 2, 'AF-20')];
    expect(summarizeAfterReview(old, reviewed)).toEqual({ score: 3, frozen: false });
    expect(summarizeAfterReview([...old, signal('signal', 1, 'AF-12')], reviewed)).toEqual({
      score: 4,
      frozen: true,
    });
    expect(summarizeAfterReview([signal('signal', 1, 'AF-12')], reviewed).frozen).toBe(false);
  });
});

describe('evaluateAll: the rules of a phase', () => {
  it('FR-REW-15: the clean project gives no signal in either phase and is not frozen', async () => {
    const { evaluateAll, summarize } = await loadRegistry();
    for (const phase of ['completion', 'cooling_end'] as const) {
      const signals = evaluateAll(cleanFacts({ phase }));
      expect(signals.filter((s) => s.action !== 'info')).toEqual([]);
      expect(summarize(signals).frozen).toBe(false);
    }
  });

  it('FR-REW-15, AF-05: a flag of the data rules reaches the result of the phase completion', async () => {
    const { evaluateAll, summarize } = await loadRegistry();
    const signals = evaluateAll(cleanFacts({ pullRequests: { changedLines: 20, maxShare: 0.4 } }));
    expect(signals.map((s) => s.ruleCode)).toContain('AF-05');
    expect(summarize(signals).frozen).toBe(true);
  });

  it('AF-12, AF-14, C-61: two scored signals (2 points) do not freeze the project in the phase completion', async () => {
    const { evaluateAll, summarize } = await loadRegistry();
    const signals = evaluateAll(twoPoints('completion'));
    expect(signals.map((s) => s.ruleCode)).toEqual(expect.arrayContaining(['AF-12', 'AF-14']));
    expect(summarize(signals)).toEqual({ score: 2, frozen: false });
  });

  it('AF-22: the rule is run in the phase cooling_end only: with the same 2 points it freezes there, not at the completion', async () => {
    const { evaluateAll, summarize } = await loadRegistry();
    expect(evaluateAll(twoPoints('completion')).map((s) => s.ruleCode)).not.toContain('AF-22');
    const later = evaluateAll(twoPoints('cooling_end'));
    expect(later.map((s) => s.ruleCode)).toContain('AF-22');
    expect(summarize(later).frozen).toBe(true);
  });

  it('AF-25, fraud_signal_uq: one signal per rule: the rule codes of a run are unique and sorted', async () => {
    const { evaluateAll } = await loadRegistry();
    const facts = twoPoints('completion');
    facts.pullRequests = { changedLines: 10, maxShare: 0.9 };
    facts.release = { ...facts.release, placeholderPage: true };
    const codes = evaluateAll(facts).map((s) => s.ruleCode);
    expect(new Set(codes).size).toBe(codes.length);
    expect(codes).toEqual([...codes].sort());
  });

  it('AF-01, AF-02: the block rules are recorded by the registry as a safety net (action block) and freeze', async () => {
    const { evaluateAll, summarize } = await loadRegistry();
    const worst = cleanFacts();
    worst.repository = { ...worst.repository, boundToCreditedProject: true };
    worst.release = { ...worst.release, heldByCreditedProject: true };
    const signals = evaluateAll(worst);
    for (const code of ['AF-01', 'AF-02']) {
      expect(signals.find((s) => s.ruleCode === code)?.action, code).toBe('block');
    }
    expect(summarize(signals).frozen).toBe(true);
  });
});
