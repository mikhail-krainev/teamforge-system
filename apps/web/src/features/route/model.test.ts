import { describe, expect, it } from 'vitest';
import { currentStage, isPastDate, nextStage, parseOrdinal, stageTitle, stepsByKey } from './model';
import { samplePlaybook, sampleStage } from './fixtures';

describe('FR-WORK-01: route model', () => {
  it('keeps a title that already starts with "Этап N" and adds the prefix otherwise', () => {
    expect(stageTitle({ ordinal: 1, title: 'Этап 1. Старт' })).toBe('Этап 1. Старт');
    expect(stageTitle({ ordinal: 2, title: 'Разработка' })).toBe('Этап 2. Разработка');
  });

  it('finds the current (open) stage and the next one by ordinal', () => {
    const stages = [
      sampleStage({ ordinal: 2, status: 'pending' }),
      sampleStage({ ordinal: 1, status: 'open' }),
    ];
    expect(currentStage(stages)?.ordinal).toBe(1);
    expect(nextStage(stages, 1)?.ordinal).toBe(2);
    expect(nextStage(stages, 2)).toBeUndefined();
  });

  it('accepts only a positive whole stage number from the URL', () => {
    expect(parseOrdinal('3')).toBe(3);
    for (const bad of ['0', '-1', '1.5', 'abc', '', '1000']) expect(parseOrdinal(bad)).toBeNull();
  });

  it('tells a past date from a future one and treats a missing date as not past', () => {
    const now = new Date('2026-06-01T00:00:00Z');
    expect(isPastDate('2026-05-31T00:00:00Z', now)).toBe(true);
    expect(isPastDate('2026-06-02T00:00:00Z', now)).toBe(false);
    expect(isPastDate(null, now)).toBe(false);
  });

  it('indexes the steps of the playbook stage by key', () => {
    const steps = stepsByKey(samplePlaybook(), 1);
    expect(steps.get('mini_spec')?.reviewItems).toHaveLength(2);
    expect(stepsByKey(undefined, 1).size).toBe(0);
  });
});
