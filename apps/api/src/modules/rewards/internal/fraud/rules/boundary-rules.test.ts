import { describe, expect, it } from 'vitest';
import {
  at,
  cleanFacts,
  DAY_MS,
  MINUTE_MS,
  run,
  withContributions,
  type FraudFacts,
  type MemberFacts,
} from '../../../test/fraud-facts.js';

/*
 * M-7 of the slice 7 review: "exactly on the boundary" tests of the rules whose mutations survived
 * (AF-12, AF-19, AF-20, AF-22). The comparisons are inclusive for AF-12 and AF-19 ("within 1 hour", "within 10
 * minutes", docs/spec.md 8) and strict for AF-22 ("not more than 1 credited project in 14 days").
 */

const SECOND_MS = 1000;
const BASE = at(5);

describe('AF-12: stages closed within one hour, the boundary is inclusive (+1)', () => {
  /** Closed stages at the given offsets (milliseconds) from `BASE`; an offset of `null` is a stage still open. */
  const closedAt = (...offsets: (number | null)[]): FraudFacts => {
    const stages = offsets.map((offset, i) => ({
      ordinal: i + 1,
      status: offset === null ? ('open' as const) : ('closed' as const),
      plannedDays: 10,
      openedAt: at(40),
      closedAt: offset === null ? null : new Date(BASE.getTime() + offset),
    }));
    return { ...cleanFacts(), stages };
  };

  it('AF-12: the first and the third stage exactly 60:00 apart give +1', async () => {
    const signals = await run('AF-12', closedAt(0, 30 * MINUTE_MS, 60 * MINUTE_MS));
    expect(signals).toHaveLength(1);
    expect(signals[0]).toMatchObject({ ruleCode: 'AF-12', action: 'signal', score: 1 });
  });

  it('AF-12: 59:59 gives +1, 60:01 is quiet', async () => {
    expect(await run('AF-12', closedAt(0, MINUTE_MS, 60 * MINUTE_MS - SECOND_MS))).toHaveLength(1);
    expect(await run('AF-12', closedAt(0, MINUTE_MS, 60 * MINUTE_MS + SECOND_MS))).toEqual([]);
  });

  it('AF-12: the whole window of three stages counts, not the gaps between neighbours (40 + 40 minutes)', async () => {
    expect(await run('AF-12', closedAt(0, 40 * MINUTE_MS, 80 * MINUTE_MS))).toEqual([]);
  });

  it('AF-12: two stages in the hour are not enough; an open stage is not a closed one', async () => {
    expect(await run('AF-12', closedAt(0, MINUTE_MS))).toEqual([]);
    expect(await run('AF-12', closedAt(0, MINUTE_MS, null))).toEqual([]);
  });

  it('AF-12: the stages are taken in the order of the time, not of the list', async () => {
    const signals = await run('AF-12', closedAt(60 * MINUTE_MS, 0, 30 * MINUTE_MS));
    expect(signals).toHaveLength(1);
  });
});

describe('AF-19: registrations or joinings within 10 minutes of each other (+1, one signal)', () => {
  const FAR_MS = 30 * DAY_MS;

  const member = (userId: string, registered: Date, joined: Date): MemberFacts => ({
    ...(cleanFacts().members[0] as MemberFacts),
    userId,
    registeredAt: registered,
    joinedAt: joined,
  });

  /** Two members: the registrations `registerGapMs` apart, the joinings `joinGapMs` apart (both far in the past). */
  const pair = (registerGapMs: number, joinGapMs: number): FraudFacts => {
    const registered = at(300);
    const joined = at(100);
    const second = member(
      'u-b',
      new Date(registered.getTime() + registerGapMs),
      new Date(joined.getTime() + joinGapMs),
    );
    return cleanFacts({ members: [member('u-a', registered, joined), second] });
  };

  it('AF-19: registrations exactly 10:00 apart give +1 and name both accounts', async () => {
    const signals = await run('AF-19', pair(10 * MINUTE_MS, FAR_MS));
    expect(signals).toHaveLength(1);
    expect(signals[0]).toMatchObject({ ruleCode: 'AF-19', action: 'signal', score: 1 });
    expect(signals[0]?.data).toEqual({ registered: ['u-a', 'u-b'], joined: [] });
  });

  it('AF-19: registrations 9:59 apart give +1, 10:01 apart are quiet', async () => {
    expect(await run('AF-19', pair(10 * MINUTE_MS - SECOND_MS, FAR_MS))).toHaveLength(1);
    expect(await run('AF-19', pair(10 * MINUTE_MS + SECOND_MS, FAR_MS))).toEqual([]);
  });

  it('AF-19: joinings exactly 10:00 apart give +1, 10:01 apart are quiet', async () => {
    const signals = await run('AF-19', pair(FAR_MS, 10 * MINUTE_MS));
    expect(signals).toHaveLength(1);
    expect(signals[0]?.data).toEqual({ registered: [], joined: ['u-a', 'u-b'] });
    expect(await run('AF-19', pair(FAR_MS, 10 * MINUTE_MS + SECOND_MS))).toEqual([]);
  });

  it('AF-19: both kinds of closeness at once still give one signal', async () => {
    expect(await run('AF-19', pair(MINUTE_MS, MINUTE_MS))).toHaveLength(1);
  });

  it('AF-19: the members are compared in the order of the time, not of the list', async () => {
    const facts = pair(10 * MINUTE_MS, FAR_MS);
    const reversed = { ...facts, members: [...facts.members].reverse() };
    expect(await run('AF-19', reversed)).toHaveLength(1);
  });

  it('AF-19: a single member cannot be close to anybody', async () => {
    const facts = pair(0, 0);
    expect(await run('AF-19', { ...facts, members: facts.members.slice(0, 1) })).toEqual([]);
  });
});

describe('AF-20: one member holds all the events, the others have none (+2)', () => {
  const [lead, backend, frontend] = cleanFacts().members as [MemberFacts, MemberFacts, MemberFacts];
  const events = (users: string[], count = 6): FraudFacts['contributions'] =>
    withContributions(count, users, (i) => 20 - i);

  it('AF-20: a project of one member is quiet even when all the events are his', async () => {
    const facts = cleanFacts({ members: [backend], contributions: events(['u-backend']) });
    expect(await run('AF-20', facts)).toEqual([]);
  });

  it('AF-20: a project of two members, all the events of one of them -> +2 with the id of the contributor', async () => {
    const facts = cleanFacts({
      members: [backend, frontend],
      contributions: events(['u-backend']),
    });
    const signals = await run('AF-20', facts);
    expect(signals).toHaveLength(1);
    expect(signals[0]).toMatchObject({ ruleCode: 'AF-20', action: 'signal', score: 2 });
    expect(signals[0]?.data).toEqual({ userId: 'u-backend', events: 6 });
  });

  it('AF-20: a project of two members with an event of each is quiet', async () => {
    const facts = cleanFacts({
      members: [backend, frontend],
      contributions: events(['u-backend', 'u-frontend']),
    });
    expect(await run('AF-20', facts)).toEqual([]);
  });

  it('AF-20: an inactive event of the other member does not count as an event', async () => {
    const inactive = events(['u-frontend'], 1).map((c) => ({ ...c, active: false }));
    const facts = cleanFacts({
      members: [backend, frontend],
      contributions: [...events(['u-backend']), ...inactive],
    });
    expect(await run('AF-20', facts)).toHaveLength(1);
  });

  it('AF-20: a project without any event is not "100 % of one member"', async () => {
    const facts = cleanFacts({ members: [backend, frontend], contributions: [] });
    expect(await run('AF-20', facts)).toEqual([]);
  });

  it('AF-20: three members, all the events of one -> +2', async () => {
    const facts = cleanFacts({
      members: [lead, backend, frontend],
      contributions: events(['u-lead']),
    });
    expect(await run('AF-20', facts)).toHaveLength(1);
  });
});

describe('AF-22: with a score of 2 or more, one credited project per 14 days (a flag of the phase cooling_end)', () => {
  /** `daysAgo` is the last other credit of the first member; the second one has none. */
  const coolingEnd = (
    daysAgo: number | null,
    scoreSoFar = 2,
    phase: FraudFacts['phase'] = 'cooling_end',
  ): FraudFacts => {
    const facts = cleanFacts();
    const [first, second] = facts.members as [MemberFacts, MemberFacts];
    const members = [
      { ...first, lastOtherCreditDaysAgo: daysAgo },
      { ...second, lastOtherCreditDaysAgo: null },
    ];
    return { ...facts, phase, scoreSoFar, members };
  };

  it('AF-22: exactly 14 days after the other credit is quiet', async () => {
    expect(await run('AF-22', coolingEnd(14))).toEqual([]);
  });

  it('AF-22: 13 days after the other credit -> a flag with the person and the score; same day too', async () => {
    const signals = await run('AF-22', coolingEnd(13));
    expect(signals).toHaveLength(1);
    expect(signals[0]).toMatchObject({ ruleCode: 'AF-22', action: 'flag', score: 0 });
    expect(signals[0]?.data).toEqual({ userIds: ['u-lead'], score: 2 });
    expect(await run('AF-22', coolingEnd(0))).toHaveLength(1);
  });

  it('AF-22: the minimum score of 2 is enough, a score of 1 is quiet even at 13 days', async () => {
    expect(await run('AF-22', coolingEnd(13, 2))).toHaveLength(1);
    expect(await run('AF-22', coolingEnd(13, 1))).toEqual([]);
  });

  it('AF-22: the rule belongs to the phase cooling_end only', async () => {
    expect(await run('AF-22', coolingEnd(13, 5, 'completion'))).toEqual([]);
  });

  it('AF-22: a person without another credit is not named', async () => {
    expect(await run('AF-22', coolingEnd(null))).toEqual([]);
  });
});
