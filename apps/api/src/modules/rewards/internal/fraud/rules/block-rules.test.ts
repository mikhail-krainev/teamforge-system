import { describe, expect, it } from 'vitest';
import {
  actionsOf,
  at,
  cleanFacts,
  DAY_MS,
  HOUR_MS,
  run,
  withContributions,
  type FraudFacts,
} from '../../../test/fraud-facts.js';

/*
 * S7-03 (written before the implementation): the BLOCK rules of docs/spec.md 8 - AF-01, AF-02, AF-04, AF-09,
 * AF-10 - as pure functions. They are the same conditions as the completion of the project (workspace
 * `completion-rules.ts`, S6-08): a blocked project cannot be completed at all, so in rewards a block is only a
 * safety net that records `action = 'block'` (architecture 10.5). Facts and the export `evaluate`: test/fraud-facts.ts.
 */

const only = async (code: string, facts: FraudFacts) => run(code, facts);

describe('AF-01: the repository belongs to one credited project, a fork has own commits', () => {
  it('AF-01: a clean project is quiet', async () => {
    expect(await only('AF-01', cleanFacts())).toEqual([]);
  });

  it('AF-01: a repository already bound to a credited project -> block', async () => {
    const facts = cleanFacts({
      repository: { ...cleanFacts().repository, boundToCreditedProject: true },
    });
    const signals = await only('AF-01', facts);
    expect(actionsOf(signals)).toEqual(['block']);
    expect(signals[0]?.ruleCode).toBe('AF-01');
  });

  it('AF-01: a fork of a foreign repository without own commits -> block', async () => {
    const facts = cleanFacts({
      repository: { ...cleanFacts().repository, forkWithoutOwnCommits: true },
    });
    expect(actionsOf(await only('AF-01', facts))).toEqual(['block']);
  });
});

describe('AF-02: the release address is unique, real and not a stub', () => {
  const withRelease = (release: Partial<FraudFacts['release']>): FraudFacts =>
    cleanFacts({ release: { ...cleanFacts().release, ...release } });

  it('AF-02: an own address is quiet', async () => {
    expect(await only('AF-02', cleanFacts())).toEqual([]);
  });

  it.each([
    'https://example.com/',
    'https://www.example.org/app',
    'https://demo.example.net/',
    'http://localhost:3000/',
  ])('AF-02: the template address %s -> block', async (url) => {
    expect(actionsOf(await only('AF-02', withRelease({ url })))).toEqual(['block']);
  });

  it('AF-02: a host that merely contains the word "example" is not a template', async () => {
    expect(await only('AF-02', withRelease({ url: 'https://myexample.com/' }))).toEqual([]);
  });

  it('AF-02: the address of another credited project -> block', async () => {
    const signals = await only('AF-02', withRelease({ heldByCreditedProject: true }));
    expect(actionsOf(signals)).toEqual(['block']);
    expect(signals[0]?.ruleCode).toBe('AF-02');
  });

  it('AF-02: a stub page ("coming soon") -> flag, not block', async () => {
    expect(actionsOf(await only('AF-02', withRelease({ placeholderPage: true })))).toEqual([
      'flag',
    ]);
  });

  it('AF-02: a template address that is also a stub gives one block (the stronger action), not two signals', async () => {
    const signals = await only(
      'AF-02',
      withRelease({ url: 'https://example.com/', placeholderPage: true }),
    );
    expect(actionsOf(signals)).toEqual(['block']);
  });
});

describe('AF-04: contribution of at least 10 merged pull requests and closed issues from 2 accounts', () => {
  it('AF-04: twelve items from two accounts are quiet; exactly ten are quiet', async () => {
    expect(await only('AF-04', cleanFacts())).toEqual([]);
    const ten = cleanFacts({
      contributions: withContributions(10, ['u-backend', 'u-frontend'], (i) => 20 - i),
    });
    expect(await only('AF-04', ten)).toEqual([]);
  });

  it('AF-04: nine items -> block', async () => {
    const nine = cleanFacts({
      contributions: withContributions(9, ['u-backend', 'u-frontend'], (i) => 20 - i),
    });
    expect(actionsOf(await only('AF-04', nine))).toEqual(['block']);
  });

  it('AF-04: artifacts and rituals are not counted: nine tasks plus three artifacts -> block', async () => {
    const base = withContributions(9, ['u-backend', 'u-frontend'], (i) => 20 - i);
    const artifacts = [1, 2, 3].map((n) => ({
      userId: 'u-backend',
      source: 'artifact' as const,
      ref: `artifact:${n}`,
      active: true,
      receivedAt: at(5),
    }));
    expect(
      actionsOf(await only('AF-04', cleanFacts({ contributions: [...base, ...artifacts] }))),
    ).toEqual(['block']);
  });

  it('AF-04: ten items of one account -> block (fewer than two accounts)', async () => {
    const single = cleanFacts({
      contributions: withContributions(10, ['u-backend'], (i) => 20 - i),
    });
    expect(actionsOf(await only('AF-04', single))).toEqual(['block']);
  });

  it('AF-04: a task credited to two assignees is one item: five tasks with two rows each -> block', async () => {
    const rows = Array.from({ length: 10 }, (_, i) => ({
      userId: i % 2 === 0 ? 'u-backend' : 'u-frontend',
      source: 'issue' as const,
      ref: `issue:7#${Math.floor(i / 2) + 1}`,
      active: true,
      receivedAt: at(20 - i),
    }));
    expect(actionsOf(await only('AF-04', cleanFacts({ contributions: rows })))).toEqual(['block']);
  });

  it('AF-04: a revoked contribution (reopened issue) is not counted', async () => {
    const items = withContributions(10, ['u-backend', 'u-frontend'], (i) => 20 - i);
    const revoked = items.map((c, i) => (i === 0 ? { ...c, active: false } : c));
    expect(actionsOf(await only('AF-04', cleanFacts({ contributions: revoked })))).toEqual([
      'block',
    ]);
  });
});

describe('AF-09: at least 14 days and at least 3 calendar days with a contribution', () => {
  const openedDaysAgo = (days: number, hours = 0): FraudFacts => {
    const facts = cleanFacts();
    const first = facts.stages[0];
    if (!first) throw new Error('no stage');
    first.openedAt = new Date(facts.now.getTime() - days * DAY_MS - hours * HOUR_MS);
    return facts;
  };

  it('AF-09: 14 whole days since the first stage opened is enough', async () => {
    expect(await only('AF-09', openedDaysAgo(14))).toEqual([]);
  });

  it('AF-09: 13 days 23 hours -> block (whole days are counted)', async () => {
    expect(actionsOf(await only('AF-09', openedDaysAgo(13, 23)))).toEqual(['block']);
  });

  it('AF-09: contributions on exactly three calendar days are quiet, on two -> block', async () => {
    const three = cleanFacts({
      contributions: withContributions(12, ['u-backend', 'u-frontend'], (i) => 5 + (i % 3)),
    });
    expect(await only('AF-09', three)).toEqual([]);
    const two = cleanFacts({
      contributions: withContributions(12, ['u-backend', 'u-frontend'], (i) => 5 + (i % 2)),
    });
    expect(actionsOf(await only('AF-09', two))).toEqual(['block']);
  });
});

describe('AF-10: no stage closed faster than 24 hours, stages closed in order', () => {
  it('AF-10: a stage closed 23 hours after its opening -> block; 24 hours is enough', async () => {
    const facts = cleanFacts();
    const stage = facts.stages[1];
    if (!stage?.openedAt) throw new Error('no stage 2');
    stage.closedAt = new Date(stage.openedAt.getTime() + 23 * HOUR_MS);
    expect(actionsOf(await only('AF-10', facts))).toEqual(['block']);
    stage.closedAt = new Date(stage.openedAt.getTime() + 24 * HOUR_MS);
    expect(await only('AF-10', facts)).toEqual([]);
  });

  it('AF-10: stages closed out of order (stage 3 before stage 2) -> block', async () => {
    const facts = cleanFacts();
    const second = facts.stages[1];
    const third = facts.stages[2];
    if (!second || !third) throw new Error('stages missing');
    const early = new Date(facts.now.getTime() - 25 * DAY_MS);
    third.openedAt = new Date(early.getTime() - 3 * DAY_MS);
    third.closedAt = early;
    expect(actionsOf(await only('AF-10', facts))).toEqual(['block']);
  });

  it('AF-10: a project whose stages follow each other is quiet', async () => {
    expect(await only('AF-10', cleanFacts())).toEqual([]);
  });
});
