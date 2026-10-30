import { describe, expect, it } from 'vitest';
import type { CompletionSnapshot } from '../../../workspace/public.js';
import {
  type AccountVerdict,
  decideMember,
  decideMembers,
  stagesNeeded,
  stagesTakenPart,
} from './credit-rules.js';
import { DAY_MS, REASON } from './constants.js';

/*
 * M-7 of the slice 7 review: fast unit tests of the pure part of the credit (FR-REW-01 to FR-REW-03, C-60) that
 * was covered by the database tests only. No database, no clock: the snapshot is a plain object.
 */

type Member = CompletionSnapshot['roster']['members'][number];
type Contribution = CompletionSnapshot['contributions'][number];

const T0 = Date.parse('2026-03-01T00:00:00Z');
const day = (n: number): string => new Date(T0 + n * DAY_MS).toISOString();

const member = (userId: string, roles = ['backend'], joinedDay = 0): Member => ({
  userId,
  isLead: false,
  joinedAt: day(joinedDay),
  joinedVia: 'queue',
  roles: roles.map((roleCode) => ({ roleCode, deficitAtJoin: false })),
});

const contribution = (
  userId: string,
  roleCode: string,
  stageOrdinal: number | null,
): Contribution => ({
  id: `c-${userId}-${roleCode}-${String(stageOrdinal)}`,
  userId,
  roleCode,
  stageOrdinal,
  source: 'issue',
  ref: `issue:1#${String(stageOrdinal)}`,
  receivedAt: day(5),
});

/** Three stages closed on the days 10, 20 and 30; the project is completed on the day 30. */
function snapshot(change: Partial<CompletionSnapshot> = {}): CompletionSnapshot {
  return {
    teamId: 't1',
    completedAt: day(30),
    startedAt: day(0),
    plannedEndAt: day(30),
    overdueDays: 0,
    productType: 'web',
    releaseUrl: null,
    repositoryId: 1,
    roster: { members: [member('u1')], seats: [], departedUserIds: [] },
    stages: [1, 2, 3].map((ordinal) => ({
      ordinal,
      stageKey: `stage-${String(ordinal)}`,
      openedAt: day((ordinal - 1) * 10),
      closedAt: day(ordinal * 10),
    })),
    contributions: [],
    participationConfirms: [],
    ...change,
  };
}

const eligible: AccountVerdict = { status: 'eligible', reasons: [] };

describe('stagesNeeded: 60 % of the stages, rounded up (C-60)', () => {
  it.each([
    [0, 0],
    [1, 1],
    [2, 2],
    [3, 2],
    [4, 3],
    [5, 3],
    [6, 4],
    [7, 5],
    [8, 5],
    [10, 6],
    [15, 9],
  ])('%i stages need %i', (total, needed) => {
    expect(stagesNeeded(total)).toBe(needed);
  });
});

describe('stagesTakenPart: a stage counts with a contribution or a confirmation of the lead (FR-REW-01 (3))', () => {
  const u1 = member('u1');

  it('counts the stages with a contribution of the person, and only those', () => {
    const snap = snapshot({
      contributions: [contribution('u1', 'backend', 1), contribution('u2', 'backend', 2)],
    });
    expect(stagesTakenPart(snap, u1)).toBe(1);
  });

  it('counts a confirmed stage without a contribution (FR-WORK-11); a stage of both kinds is counted once', () => {
    const snap = snapshot({
      contributions: [contribution('u1', 'backend', 1), contribution('u1', 'backend', 1)],
      participationConfirms: [
        { userId: 'u1', stageOrdinal: 1 },
        { userId: 'u1', stageOrdinal: 2 },
        { userId: 'u2', stageOrdinal: 3 },
      ],
    });
    expect(stagesTakenPart(snap, u1)).toBe(2);
  });

  it('does not count a contribution that belongs to no stage', () => {
    const snap = snapshot({ contributions: [contribution('u1', 'backend', null)] });
    expect(stagesTakenPart(snap, u1)).toBe(0);
  });

  it('counts only the stages that were open when the person joined: joined on the closing moment counts', () => {
    const all = [1, 2, 3].map((ordinal) => contribution('u1', 'backend', ordinal));
    const joinedAtClose = member('u1', ['backend'], 20);
    expect(stagesTakenPart(snapshot({ contributions: all }), joinedAtClose)).toBe(2);
    const joinedLater = {
      ...joinedAtClose,
      joinedAt: new Date(T0 + 20 * DAY_MS + 1000).toISOString(),
    };
    expect(stagesTakenPart(snapshot({ contributions: all }), joinedLater)).toBe(1);
  });

  it('takes the completion time as the end of a stage that was never closed', () => {
    const open = snapshot({
      stages: [{ ordinal: 1, stageKey: 'stage-1', openedAt: day(0), closedAt: null }],
      contributions: [contribution('u1', 'backend', 1)],
    });
    expect(stagesTakenPart(open, member('u1', ['backend'], 30))).toBe(1);
    expect(stagesTakenPart(open, member('u1', ['backend'], 31))).toBe(0);
  });
});

describe('decideMember: the verdict of the conditions (2), (3) and (5) of FR-REW-01', () => {
  const full = (userId: string, roleCode = 'backend'): Contribution[] =>
    [1, 2, 3].map((ordinal) => contribution(userId, roleCode, ordinal));

  it('credits a person with contributions in all the stages and an eligible account', () => {
    const snap = snapshot({ contributions: full('u1') });
    expect(decideMember(snap, member('u1'), eligible)).toEqual({
      userId: 'u1',
      status: 'credited',
      reason: null,
      roles: [{ roleCode: 'backend', deficitAtJoin: false }],
    });
  });

  it('denies a person without a contribution and keeps every held role in the row', () => {
    const holder = member('u1', ['backend', 'qa']);
    const decision = decideMember(snapshot(), holder, eligible);
    expect(decision.status).toBe('denied');
    expect(decision.reason).toBe(REASON.noContribution);
    expect(decision.roles.map((r) => r.roleCode)).toEqual(['backend', 'qa']);
  });

  it('denies below the share of the stages (1 of 3) and credits exactly at it (2 of 3)', () => {
    const one = snapshot({ contributions: [contribution('u1', 'backend', 1)] });
    const denied = decideMember(one, member('u1'), eligible);
    expect(denied).toMatchObject({ status: 'denied', reason: REASON.tooFewStages });
    expect(denied.roles).toEqual([{ roleCode: 'backend', deficitAtJoin: false }]);
    const two = snapshot({
      contributions: [contribution('u1', 'backend', 1), contribution('u1', 'backend', 2)],
    });
    expect(decideMember(two, member('u1'), eligible).status).toBe('credited');
  });

  it('a stage confirmed by the lead together with a contribution in another one is enough', () => {
    const snap = snapshot({
      contributions: [contribution('u1', 'backend', 1)],
      participationConfirms: [{ userId: 'u1', stageOrdinal: 3 }],
    });
    expect(decideMember(snap, member('u1'), eligible).status).toBe('credited');
  });
});

describe('decideMember: the account (FR-GH-09) postpones, it does not refuse', () => {
  const snap = snapshot({
    contributions: [1, 2, 3].map((ordinal) => contribution('u1', 'backend', ordinal)),
  });

  it('a pending account gives pending_account with the first reason', () => {
    const pending: AccountVerdict = {
      status: 'pending_account',
      reasons: ['ACCOUNT_TOO_YOUNG', 'X'],
    };
    expect(decideMember(snap, member('u1'), pending)).toMatchObject({
      status: 'pending_account',
      reason: 'ACCOUNT_TOO_YOUNG',
    });
  });

  it('an account that was not checked (no verdict, or "unknown") waits with ACCOUNT_NOT_CHECKED', () => {
    const waiting = { status: 'pending_account', reason: REASON.accountNotChecked };
    expect(decideMember(snap, member('u1'), undefined)).toMatchObject(waiting);
    expect(decideMember(snap, member('u1'), { status: 'unknown', reasons: [] })).toMatchObject(
      waiting,
    );
  });

  it('a person denied for the stages is denied whatever the account says', () => {
    const few = snapshot({ contributions: [contribution('u1', 'backend', 1)] });
    const pending: AccountVerdict = { status: 'pending_account', reasons: ['ACCOUNT_TOO_YOUNG'] };
    expect(decideMember(few, member('u1'), pending).status).toBe('denied');
  });
});

describe('decideMember: the roles of the credit (FR-REW-02, FR-REW-03)', () => {
  const stages = (userId: string, roleCode: string): Contribution[] =>
    [1, 2, 3].map((ordinal) => contribution(userId, roleCode, ordinal));

  it('a credit goes by the roles of the contributions only, ordered by code; the held-only role gets none', () => {
    const holder = member('u1', ['qa', 'backend', 'design']);
    const snap = snapshot({
      contributions: [...stages('u1', 'qa'), contribution('u1', 'backend', 1)],
    });
    const decision = decideMember(snap, holder, eligible);
    expect(decision.roles.map((r) => r.roleCode)).toEqual(['backend', 'qa']);
  });

  it('the flag deficit_at_join comes from the held role; a role that is not held (a fallback step) has none', () => {
    const holder: Member = {
      ...member('u1'),
      roles: [{ roleCode: 'backend', deficitAtJoin: true }],
    };
    const snap = snapshot({
      contributions: [...stages('u1', 'backend'), contribution('u1', 'devops', 1)],
    });
    expect(decideMember(snap, holder, eligible).roles).toEqual([
      { roleCode: 'backend', deficitAtJoin: true },
      { roleCode: 'devops', deficitAtJoin: false },
    ]);
  });
});

describe('decideMembers: every person active at the completion is decided (FR-REW-01 (1))', () => {
  it('decides the roster members; a person who left early is not in the roster and gets no row', () => {
    const snap = snapshot({
      roster: {
        members: [member('u1'), member('u2')],
        seats: [],
        departedUserIds: ['u3'],
      },
      contributions: [1, 2, 3].flatMap((ordinal) => [
        contribution('u1', 'backend', ordinal),
        contribution('u3', 'backend', ordinal),
      ]),
    });
    const accounts = new Map<string, AccountVerdict>([
      ['u1', eligible],
      ['u2', { status: 'pending_account', reasons: ['ACCOUNT_TOO_YOUNG'] }],
      ['u3', eligible],
    ]);
    const decisions = decideMembers(snap, accounts);
    expect(decisions.map((d) => [d.userId, d.status, d.reason])).toEqual([
      ['u1', 'credited', null],
      ['u2', 'denied', REASON.noContribution],
    ]);
  });

  it('takes the verdict of each person from the map by his id', () => {
    const snap = snapshot({
      roster: { members: [member('u1'), member('u2')], seats: [], departedUserIds: [] },
      contributions: [1, 2, 3].flatMap((ordinal) => [
        contribution('u1', 'backend', ordinal),
        contribution('u2', 'backend', ordinal),
      ]),
    });
    const decisions = decideMembers(snap, new Map([['u2', eligible]]));
    expect(decisions.map((d) => [d.userId, d.status])).toEqual([
      ['u1', 'pending_account'],
      ['u2', 'credited'],
    ]);
  });
});
