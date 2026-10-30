import { describe, expect, it } from 'vitest';
import {
  actionsOf,
  at,
  cleanFacts,
  DAY_MS,
  HOUR_MS,
  MINUTE_MS,
  run,
  scoreOf,
  withContributions,
  type FraudFacts,
} from '../../../test/fraud-facts.js';

/*
 * S7-03 (written before the implementation): the FLAG and SIGNAL rules that read the data of the project -
 * AF-03, AF-05, AF-06, AF-07, AF-08, AF-11, AF-12, AF-13, AF-14 (docs/spec.md 8; thresholds C-55, C-61). Each rule
 * is quiet on the clean project of test/fraud-facts.ts, fires on its condition and has its boundary tested.
 * A `flag` and a `block` carry no score of their own (FR-REW-15: the project is frozen by the action); the
 * `signal` rules carry the score of the table.
 */

describe('AF-03: the repository was created more than 30 days before the start of the project (C-55)', () => {
  const created = (daysBeforeStart: number): FraudFacts => {
    const facts = cleanFacts();
    return {
      ...facts,
      repository: {
        ...facts.repository,
        createdAt: new Date(facts.team.startedAt.getTime() - daysBeforeStart * DAY_MS),
      },
    };
  };

  it('AF-03: a repository older than the start by exactly 30 days is quiet, by 30 days and one hour -> flag', async () => {
    expect(await run('AF-03', created(30))).toEqual([]);
    const facts = created(30);
    facts.repository.createdAt = new Date(facts.repository.createdAt.getTime() - HOUR_MS);
    expect(actionsOf(await run('AF-03', facts))).toEqual(['flag']);
  });

  it('AF-03: a repository created after the start is quiet', async () => {
    expect(await run('AF-03', created(-2))).toEqual([]);
  });
});

describe('AF-05: fewer than 200 changed lines in merged pull requests, or one pull request above 80 %', () => {
  const stats = (changedLines: number, maxShare: number): FraudFacts =>
    cleanFacts({ pullRequests: { changedLines, maxShare } });

  it('AF-05: 480 lines and a share of 34 % are quiet; exactly 200 lines and exactly 80 % are quiet', async () => {
    expect(await run('AF-05', cleanFacts())).toEqual([]);
    expect(await run('AF-05', stats(200, 0.8))).toEqual([]);
  });

  it('AF-05: 199 lines -> flag; no pull request at all (0 lines) -> flag', async () => {
    expect(actionsOf(await run('AF-05', stats(199, 0.5)))).toEqual(['flag']);
    expect(actionsOf(await run('AF-05', stats(0, 0)))).toEqual(['flag']);
  });

  it('AF-05: one pull request with 81 % of the changes -> flag, with the share in the data', async () => {
    const signals = await run('AF-05', stats(900, 0.81));
    expect(actionsOf(signals)).toEqual(['flag']);
    expect(signals[0]?.ruleCode).toBe('AF-05');
    expect(signals[0]?.data).toBeDefined();
  });

  it('AF-05: both conditions at once give one signal, not two (one row per rule and phase, fraud_signal_uq)', async () => {
    expect(await run('AF-05', stats(50, 0.95))).toHaveLength(1);
  });
});

describe('AF-06: artifact files repeat the files of another project, or are empty', () => {
  const file = (change: Partial<FraudFacts['artifacts'][number]>): FraudFacts => {
    const facts = cleanFacts();
    return {
      ...facts,
      artifacts: [{ ...(facts.artifacts[0] as FraudFacts['artifacts'][number]), ...change }],
    };
  };

  it('AF-06: unique files are quiet; a project without artifact files is quiet', async () => {
    expect(await run('AF-06', cleanFacts())).toEqual([]);
    expect(await run('AF-06', cleanFacts({ artifacts: [] }))).toEqual([]);
  });

  it('AF-06: the SHA-256 of a file matches a file of another project -> flag', async () => {
    expect(actionsOf(await run('AF-06', file({ sameHashInOtherTeam: true })))).toEqual(['flag']);
  });

  it('AF-06: an empty file -> flag; a file of one byte is not empty', async () => {
    expect(actionsOf(await run('AF-06', file({ sizeBytes: 0 })))).toEqual(['flag']);
    expect(await run('AF-06', file({ sizeBytes: 1 }))).toEqual([]);
  });

  it('AF-06: several repeated files give one flag', async () => {
    const facts = cleanFacts();
    const twice = facts.artifacts.map((a) => ({ ...a, sameHashInOtherTeam: true }));
    expect(await run('AF-06', cleanFacts({ artifacts: twice }))).toHaveLength(1);
  });
});

describe('AF-07: more than 70 % of the contribution events in the last 48 hours of the project', () => {
  /** Ten events, `late` of them in the last 48 hours before the completion, the rest earlier. */
  const events = (late: number): FraudFacts =>
    cleanFacts({
      contributions: withContributions(10, ['u-backend', 'u-frontend'], (i) =>
        i < late ? 1 : 10 + i,
      ),
    });

  it('AF-07: seven of ten (70 %) are quiet, eight of ten (80 %) -> flag', async () => {
    expect(await run('AF-07', events(7))).toEqual([]);
    expect(actionsOf(await run('AF-07', events(8)))).toEqual(['flag']);
  });

  it('AF-07: the clean project, with its events spread over four weeks, is quiet', async () => {
    expect(await run('AF-07', cleanFacts())).toEqual([]);
  });

  it('AF-07: the window is counted back from the completion, not from now', async () => {
    const facts = events(8);
    const completedLongAgo = new Date(facts.now.getTime() - 100 * DAY_MS);
    const shifted = {
      ...facts,
      team: { ...facts.team, completedAt: completedLongAgo },
      contributions: facts.contributions.map((c) => ({
        ...c,
        receivedAt: new Date(c.receivedAt.getTime() - 100 * DAY_MS),
      })),
    };
    expect(actionsOf(await run('AF-07', shifted))).toEqual(['flag']);
  });

  it('AF-07: a project without contributions does not divide by zero', async () => {
    expect(await run('AF-07', cleanFacts({ contributions: [] }))).toEqual([]);
  });
});

describe('AF-08: name and description repeat a credited project of the same team (+1)', () => {
  const earlier = (name: string, description: string): FraudFacts =>
    cleanFacts({ earlierProjects: [{ name, description }] });

  it('AF-08: no earlier project is quiet; another name or another description is quiet', async () => {
    expect(await run('AF-08', cleanFacts())).toEqual([]);
    expect(
      await run('AF-08', earlier('Другой проект', 'Сервис для учёта задач небольших команд')),
    ).toEqual([]);
    expect(await run('AF-08', earlier('Доска задач', 'Совсем другое описание'))).toEqual([]);
  });

  it('AF-08: the same name and description -> a signal of +1', async () => {
    const signals = await run(
      'AF-08',
      earlier('Доска задач', 'Сервис для учёта задач небольших команд'),
    );
    expect(actionsOf(signals)).toEqual(['signal']);
    expect(scoreOf(signals)).toBe(1);
  });

  it('AF-08: the comparison is normalised: case, outer and repeated spaces do not matter', async () => {
    const signals = await run(
      'AF-08',
      earlier('  ДОСКА   задач ', 'сервис для учёта  задач небольших команд '),
    );
    expect(scoreOf(signals)).toBe(1);
  });
});

describe('AF-11: completion within 24 hours of the team, or all stages closed in under 20 % of the plan', () => {
  it('AF-11: a team of 40 days and stages of 30 days are quiet', async () => {
    expect(await run('AF-11', cleanFacts())).toEqual([]);
  });

  it('AF-11: completed 23 hours after the team was created -> flag; after 24 hours - quiet', async () => {
    const quick = cleanFacts();
    quick.team.createdAt = new Date(quick.team.completedAt.getTime() - 23 * HOUR_MS);
    expect(actionsOf(await run('AF-11', quick))).toEqual(['flag']);
    quick.team.createdAt = new Date(quick.team.completedAt.getTime() - 24 * HOUR_MS);
    expect(await run('AF-11', quick)).toEqual([]);
  });

  /** Three stages of 10 planned days closed `days` days after the first one opened. */
  const compressed = (days: number): FraudFacts => {
    const facts = cleanFacts();
    const start = facts.stages[0]?.openedAt ?? facts.now;
    facts.stages = facts.stages.map((s, i) => ({
      ...s,
      openedAt: new Date(start.getTime() + (i * days * DAY_MS) / 3),
      closedAt: new Date(start.getTime() + ((i + 1) * days * DAY_MS) / 3),
    }));
    return facts;
  };

  it('AF-11: stages closed in 5 of 30 planned days (17 %) -> flag; in 6 days (exactly 20 %) - quiet', async () => {
    expect(actionsOf(await run('AF-11', compressed(5)))).toEqual(['flag']);
    expect(await run('AF-11', compressed(6))).toEqual([]);
  });

  it('AF-11: both conditions give one flag', async () => {
    const both = compressed(2);
    both.team.createdAt = new Date(both.team.completedAt.getTime() - HOUR_MS);
    expect(await run('AF-11', both)).toHaveLength(1);
  });
});

describe('AF-12: three or more stages closed within one hour (+1)', () => {
  const closedWithin = (minutes: number[]): FraudFacts => {
    const facts = cleanFacts();
    const base = facts.stages[0]?.openedAt ?? facts.now;
    facts.stages = minutes.map((m, i) => ({
      ordinal: i + 1,
      status: 'closed',
      plannedDays: 10,
      openedAt: new Date(base.getTime() + i * DAY_MS),
      closedAt: new Date(base.getTime() + 20 * DAY_MS + m * MINUTE_MS),
    }));
    return facts;
  };

  it('AF-12: stages closed ten days apart are quiet', async () => {
    expect(await run('AF-12', cleanFacts())).toEqual([]);
  });

  it('AF-12: three stages closed within 40 minutes -> a signal of +1', async () => {
    const signals = await run('AF-12', closedWithin([0, 20, 40]));
    expect(actionsOf(signals)).toEqual(['signal']);
    expect(scoreOf(signals)).toBe(1);
  });

  it('AF-12: only two stages within the hour (the third a day later) are quiet', async () => {
    expect(await run('AF-12', closedWithin([0, 30, 24 * 60]))).toEqual([]);
  });

  it('AF-12: three stages in 61 minutes are quiet; four stages with three of them in the hour still give +1, not +2', async () => {
    expect(await run('AF-12', closedWithin([0, 30, 61]))).toEqual([]);
    expect(scoreOf(await run('AF-12', closedWithin([0, 10, 20, 24 * 60])))).toBe(1);
  });
});

describe('AF-13: the same three or more people complete projects together: 2 projects +1, 3 or more flag', () => {
  const roster = (sameRosterProjects: number): FraudFacts => cleanFacts({ sameRosterProjects });

  it('AF-13: the first project of the roster is quiet', async () => {
    expect(await run('AF-13', roster(1))).toEqual([]);
  });

  it('AF-13: the second project of the same roster -> a signal of +1', async () => {
    const signals = await run('AF-13', roster(2));
    expect(actionsOf(signals)).toEqual(['signal']);
    expect(scoreOf(signals)).toBe(1);
  });

  it('AF-13: the third and the fourth project of the same roster -> flag', async () => {
    expect(actionsOf(await run('AF-13', roster(3)))).toEqual(['flag']);
    expect(actionsOf(await run('AF-13', roster(4)))).toEqual(['flag']);
  });

  it('AF-13: a roster of two people is not "a circle of three or more": quiet', async () => {
    const pair = roster(3);
    pair.members = pair.members.slice(0, 2);
    expect(await run('AF-13', pair)).toEqual([]);
  });
});

describe('AF-14: the mark "желательная" set less than 7 days before the completion (C-17): +1', () => {
  const marked = (daysBeforeCompletion: number): FraudFacts =>
    cleanFacts({ desiredMarks: [{ roleCode: 'backend', changedAt: at(daysBeforeCompletion) }] });

  it('AF-14: a mark of 40 days ago and a project without marks are quiet', async () => {
    expect(await run('AF-14', cleanFacts())).toEqual([]);
    expect(await run('AF-14', cleanFacts({ desiredMarks: [] }))).toEqual([]);
  });

  it('AF-14: a mark of 6 days ago -> a signal of +1, with the role in the data', async () => {
    const signals = await run('AF-14', marked(6));
    expect(actionsOf(signals)).toEqual(['signal']);
    expect(scoreOf(signals)).toBe(1);
  });

  it('AF-14: a mark of exactly 7 days ago is quiet, of 6 days 23 hours is not', async () => {
    expect(await run('AF-14', marked(7))).toEqual([]);
    const facts = marked(7);
    const [mark] = facts.desiredMarks;
    if (mark) mark.changedAt = new Date(mark.changedAt.getTime() + HOUR_MS);
    expect(scoreOf(await run('AF-14', facts))).toBe(1);
  });

  it('AF-14: the signal does not cancel anything: it is a signal, never a block or a flag', async () => {
    expect(actionsOf(await run('AF-14', marked(1)))).not.toContain('block');
    expect(actionsOf(await run('AF-14', marked(1)))).not.toContain('flag');
  });
});
