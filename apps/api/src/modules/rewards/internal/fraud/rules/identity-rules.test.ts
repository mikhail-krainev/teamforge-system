import { describe, expect, it } from 'vitest';
import {
  actionsOf,
  at,
  cleanFacts,
  MINUTE_MS,
  run,
  scoreOf,
  USERS,
  withContributions,
  type FraudFacts,
  type IdentitySignalFacts,
} from '../../../test/fraud-facts.js';

/*
 * S7-03 (written before the implementation): the rules about people and accounts - AF-15..AF-22 (docs/spec.md 8,
 * SEC-13; architecture 10.5). They read HMACs of the network and the device from `AuthApi.getIdentitySignals`,
 * the tombstones of deleted accounts and the text fingerprints; raw addresses never reach a rule. AF-15 is a
 * block only at the registration (slice 2); here the tombstone is "только сигнал" (plan S7-03). AF-16 defers the
 * credit and never freezes (an `info` row). AF-22 is a flag of the phase `cooling_end` (Р-13).
 */

const [LEAD, BACKEND, FRONTEND] = USERS;

/** The same HMAC of `kind` for the given users on top of the clean signals (those of the others stay distinct). */
function shared(
  kind: IdentitySignalFacts['kind'],
  users: readonly string[],
): IdentitySignalFacts[] {
  const own = cleanFacts().identitySignals.filter(
    (s) => !(s.kind === kind && users.includes(s.userId)),
  );
  return [...own, ...users.map((userId) => ({ userId, kind, valueHmac: `shared-${kind}` }))];
}

describe('AF-15: the account matches the tombstone of a deleted one (SEC-13): a signal, never a block here', () => {
  it('AF-15: a clean roster is quiet', async () => {
    expect(await run('AF-15', cleanFacts())).toEqual([]);
  });

  it('AF-15: a member whose GitHub id or email matches a tombstone -> a signal with a score', async () => {
    const facts = cleanFacts();
    facts.members = facts.members.map((m) =>
      m.userId === BACKEND ? { ...m, tombstoneMatch: true } : m,
    );
    const signals = await run('AF-15', facts);
    expect(actionsOf(signals)).toEqual(['signal']);
    expect(scoreOf(signals)).toBeGreaterThan(0);
    expect(JSON.stringify(signals[0]?.data)).toContain(BACKEND);
  });
});

describe('AF-16: an account younger than 30 days or without public activity defers the credit (C-59)', () => {
  const accountOf = (
    account: { ageDays: number; hasPublicActivity: boolean } | null,
  ): FraudFacts => {
    const facts = cleanFacts();
    facts.members = facts.members.map((m) => (m.userId === BACKEND ? { ...m, account } : m));
    return facts;
  };

  it('AF-16: accounts of 400 days with activity are quiet; of exactly 30 days are quiet', async () => {
    expect(await run('AF-16', cleanFacts())).toEqual([]);
    expect(await run('AF-16', accountOf({ ageDays: 30, hasPublicActivity: true }))).toEqual([]);
  });

  it('AF-16: 29 days, no public activity, or no check yet -> an info row that lists the member, not a flag', async () => {
    for (const account of [
      { ageDays: 29, hasPublicActivity: true },
      { ageDays: 400, hasPublicActivity: false },
      null,
    ]) {
      const signals = await run('AF-16', accountOf(account));
      expect(actionsOf(signals)).toEqual(['info']);
      expect(scoreOf(signals)).toBe(0);
      expect(JSON.stringify(signals[0]?.data)).toContain(BACKEND);
    }
  });
});

describe('AF-17: a shared network or device fingerprint: two members +1, three or more +2', () => {
  it('AF-17: distinct fingerprints are quiet', async () => {
    expect(await run('AF-17', cleanFacts())).toEqual([]);
  });

  it.each(['ip24', 'device'] as const)(
    'AF-17: two members with the same %s -> +1',
    async (kind) => {
      const signals = await run(
        'AF-17',
        cleanFacts({ identitySignals: shared(kind, [BACKEND, FRONTEND]) }),
      );
      expect(actionsOf(signals)).toEqual(['signal']);
      expect(scoreOf(signals)).toBe(1);
    },
  );

  it('M-3: AF-17: a shared user agent alone is no signal, even for three members', async () => {
    const signals = await run(
      'AF-17',
      cleanFacts({ identitySignals: shared('ua', [LEAD, BACKEND, FRONTEND]) }),
    );
    expect(signals).toEqual([]);
  });

  it('AF-17: three members with the same subnet -> +2', async () => {
    const signals = await run(
      'AF-17',
      cleanFacts({ identitySignals: shared('ip24', [LEAD, BACKEND, FRONTEND]) }),
    );
    expect(scoreOf(signals)).toBe(2);
  });

  it('AF-17: the same value twice for one member is one member, not two', async () => {
    const doubled = [
      ...shared('ip24', [BACKEND]),
      { userId: BACKEND, kind: 'ip24' as const, valueHmac: 'shared-ip24' },
    ];
    expect(await run('AF-17', cleanFacts({ identitySignals: doubled }))).toEqual([]);
  });

  it('AF-17: a member without any recorded signals does not match anybody', async () => {
    const none = cleanFacts().identitySignals.filter((s) => s.userId !== BACKEND);
    expect(await run('AF-17', cleanFacts({ identitySignals: none }))).toEqual([]);
  });
});

describe('AF-18: identical profile or resume text of different accounts (+2)', () => {
  it('AF-18: unique texts are quiet; a member without a text is quiet', async () => {
    expect(await run('AF-18', cleanFacts())).toEqual([]);
    const facts = cleanFacts();
    facts.members = facts.members.map((m) => ({ ...m, textHash: null }));
    expect(await run('AF-18', facts)).toEqual([]);
  });

  it('AF-18: two members with the same text hash -> +2', async () => {
    const facts = cleanFacts();
    facts.members = facts.members.map((m) =>
      m.userId === FRONTEND ? { ...m, textHash: `hash-${BACKEND}` } : m,
    );
    facts.textHolders = { ...facts.textHolders, [`hash-${BACKEND}`]: [BACKEND, FRONTEND] };
    const signals = await run('AF-18', facts);
    expect(actionsOf(signals)).toEqual(['signal']);
    expect(scoreOf(signals)).toBe(2);
  });

  it('AF-18: the text of a member is held by an account outside the team too -> +2', async () => {
    const facts = cleanFacts();
    facts.textHolders = { ...facts.textHolders, [`hash-${LEAD}`]: [LEAD, 'u-stranger'] };
    expect(scoreOf(await run('AF-18', facts))).toBe(2);
  });

  it('AF-18: a hash held by two outsiders and no member is not about this team', async () => {
    const facts = cleanFacts();
    facts.textHolders = { ...facts.textHolders, 'hash-x': ['u-a', 'u-b'] };
    expect(await run('AF-18', facts)).toEqual([]);
  });
});

describe('AF-19: two accounts registered or joined within 10 minutes of each other (+1)', () => {
  const closeBy = (field: 'registeredAt' | 'joinedAt', minutes: number): FraudFacts => {
    const facts = cleanFacts();
    const base = facts.members[1]?.[field] ?? facts.now;
    facts.members = facts.members.map((m) =>
      m.userId === FRONTEND ? { ...m, [field]: new Date(base.getTime() + minutes * MINUTE_MS) } : m,
    );
    return facts;
  };

  it('AF-19: members who joined days apart are quiet', async () => {
    expect(await run('AF-19', cleanFacts())).toEqual([]);
  });

  it.each(['registeredAt', 'joinedAt'] as const)(
    'AF-19: %s 9 minutes apart -> +1',
    async (field) => {
      const signals = await run('AF-19', closeBy(field, 9));
      expect(actionsOf(signals)).toEqual(['signal']);
      expect(scoreOf(signals)).toBe(1);
    },
  );

  it.each(['registeredAt', 'joinedAt'] as const)(
    'AF-19: %s 11 minutes apart is quiet',
    async (field) => {
      expect(await run('AF-19', closeBy(field, 11))).toEqual([]);
    },
  );

  it('AF-19: several close pairs still give one signal of +1', async () => {
    const facts = closeBy('registeredAt', 3);
    const anchor = facts.members[1]?.registeredAt ?? facts.now;
    facts.members = facts.members.map((m) =>
      m.userId === LEAD ? { ...m, registeredAt: new Date(anchor.getTime() + 5 * MINUTE_MS) } : m,
    );
    expect(scoreOf(await run('AF-19', facts))).toBe(1);
  });
});

describe('AF-20: one participant has all the contribution and the others none (+2)', () => {
  it('AF-20: two contributors are quiet', async () => {
    expect(await run('AF-20', cleanFacts())).toEqual([]);
  });

  it('AF-20: twelve items of one member and nobody else with an event -> +2', async () => {
    const solo = cleanFacts({ contributions: withContributions(12, [BACKEND], (i) => 20 - i) });
    const signals = await run('AF-20', solo);
    expect(actionsOf(signals)).toEqual(['signal']);
    expect(scoreOf(signals)).toBe(2);
  });

  it('AF-20: another member with one artifact (not a task) is an event of that member: quiet', async () => {
    const items = withContributions(12, [BACKEND], (i) => 20 - i);
    const artifact = {
      userId: FRONTEND,
      source: 'artifact' as const,
      ref: 'artifact:1',
      active: true,
      receivedAt: at(3),
    };
    expect(await run('AF-20', cleanFacts({ contributions: [...items, artifact] }))).toEqual([]);
  });

  it('AF-20: a project without any contribution is not "100 % of one member"', async () => {
    expect(await run('AF-20', cleanFacts({ contributions: [] }))).toEqual([]);
  });
});

describe('AF-21: linked accounts - at least three features in common - a flag, not a block', () => {
  it('AF-21: unrelated accounts are quiet', async () => {
    expect(await run('AF-21', cleanFacts())).toEqual([]);
  });

  it('AF-21: a pair with the same subnet, user agent and device (3 features) -> flag', async () => {
    const signals = [
      ...shared('ip24', [BACKEND, FRONTEND]).filter((s) => s.kind === 'ip24'),
      ...shared('ua', [BACKEND, FRONTEND]).filter((s) => s.kind === 'ua'),
      ...shared('device', [BACKEND, FRONTEND]).filter((s) => s.kind === 'device'),
    ];
    const facts = cleanFacts({
      identitySignals: [...signals, { userId: LEAD, kind: 'ip24', valueHmac: 'ip-lead' }],
    });
    expect(actionsOf(await run('AF-21', facts))).toEqual(['flag']);
  });

  it('AF-21: a pair with two features (subnet and device) is quiet', async () => {
    const signals = [
      ...shared('ip24', [BACKEND, FRONTEND]).filter((s) => s.kind === 'ip24'),
      ...shared('device', [BACKEND, FRONTEND]).filter((s) => s.kind === 'device'),
      { userId: BACKEND, kind: 'ua' as const, valueHmac: 'ua-b' },
      { userId: FRONTEND, kind: 'ua' as const, valueHmac: 'ua-f' },
    ];
    expect(await run('AF-21', cleanFacts({ identitySignals: signals }))).toEqual([]);
  });

  it('AF-21: two network features plus the same profile text make three -> flag', async () => {
    const facts = cleanFacts({
      identitySignals: [
        ...shared('ip24', [BACKEND, FRONTEND]).filter((s) => s.kind === 'ip24'),
        ...shared('device', [BACKEND, FRONTEND]).filter((s) => s.kind === 'device'),
      ],
    });
    facts.members = facts.members.map((m) =>
      m.userId === FRONTEND ? { ...m, textHash: `hash-${BACKEND}` } : m,
    );
    facts.textHolders = { [`hash-${BACKEND}`]: [BACKEND, FRONTEND] };
    expect(actionsOf(await run('AF-21', facts))).toEqual(['flag']);
  });

  it('AF-21: features spread over different pairs do not add up: quiet', async () => {
    const facts = cleanFacts({
      identitySignals: [
        { userId: LEAD, kind: 'ip24', valueHmac: 'one' },
        { userId: BACKEND, kind: 'ip24', valueHmac: 'one' },
        { userId: BACKEND, kind: 'ua', valueHmac: 'two' },
        { userId: FRONTEND, kind: 'ua', valueHmac: 'two' },
        { userId: LEAD, kind: 'device', valueHmac: 'three' },
        { userId: FRONTEND, kind: 'device', valueHmac: 'three' },
      ],
    });
    expect(await run('AF-21', facts)).toEqual([]);
  });
});

describe('AF-22: with a score of 2 or more, at most one credited project per person in 14 days (Р-13)', () => {
  const credited = (change: {
    phase?: 'completion' | 'cooling_end';
    score: number;
    daysAgo: number | null;
  }): FraudFacts => {
    const facts = cleanFacts({ phase: change.phase ?? 'cooling_end', scoreSoFar: change.score });
    facts.members = facts.members.map((m) =>
      m.userId === BACKEND ? { ...m, lastOtherCreditDaysAgo: change.daysAgo } : m,
    );
    return facts;
  };

  it('AF-22: a score of 2 and a credit of another project 13 days ago -> flag (manual review, not a refusal)', async () => {
    const signals = await run('AF-22', credited({ score: 2, daysAgo: 13 }));
    expect(actionsOf(signals)).toEqual(['flag']);
    expect(signals[0]?.ruleCode).toBe('AF-22');
  });

  it('AF-22: a score of 1 is quiet however many projects the person has', async () => {
    expect(await run('AF-22', credited({ score: 1, daysAgo: 1 }))).toEqual([]);
  });

  it('AF-22: a score of 3 and the other credit 15 days ago, or none, is quiet', async () => {
    expect(await run('AF-22', credited({ score: 3, daysAgo: 15 }))).toEqual([]);
    expect(await run('AF-22', credited({ score: 3, daysAgo: null }))).toEqual([]);
  });

  it('AF-22: it is a rule of the phase cooling_end: in the phase completion it is quiet', async () => {
    expect(await run('AF-22', credited({ phase: 'completion', score: 3, daysAgo: 1 }))).toEqual([]);
  });
});
