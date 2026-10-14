import { describe, expect, it } from 'vitest';
import {
  EXTENSION_MS,
  isMajority,
  isOpenStatus,
  leadInactive,
  NOMINATION_MS,
  OFFER_MS,
  openingCase,
  phaseDeadline,
  quorumOf,
  requestsRequired,
  RUNOFF_MS,
  transition,
  VOTE_STATUSES,
  VOTING_MS,
  type VoteEvent,
  type VoteOutcome,
  type VoteState,
  type VoteStatus,
} from './leader-vote-machine.js';

const s = (status: VoteStatus, round: 1 | 2 = 1, extended = false): VoteState => ({
  status,
  round,
  extended,
});

interface Expected {
  status: VoteStatus;
  round?: 1 | 2;
  extended?: boolean;
  outcome?: VoteOutcome;
  tieBreak?: boolean;
  suspendTeam?: boolean;
}

interface Row {
  name: string;
  from: VoteState;
  event: VoteEvent;
  to: Expected | undefined;
}

const cancelled: Expected = { status: 'cancelled', outcome: 'cancelled_lead_returned' };

const emptied: Expected = { status: 'closed', outcome: 'archived' };

const TABLE: Row[] = [
  ...(['nominating', 'voting', 'runoff', 'confirming', 'offering'] as const).map((status): Row => ({
    name: `${status} -> closed (the last member left, archived)`,
    from: s(status),
    event: { type: 'team_emptied' },
    to: emptied,
  })),
  ...(['closed', 'cancelled'] as const).map((status): Row => ({
    name: `${status} ignores an emptied team`,
    from: s(status),
    event: { type: 'team_emptied' },
    to: undefined,
  })),
  {
    name: 'nominating -> voting',
    from: s('nominating'),
    event: { type: 'nomination_deadline', confirmedCandidates: 2 },
    to: { status: 'voting' },
  },
  {
    name: 'nominating -> offering (no candidates)',
    from: s('nominating'),
    event: { type: 'nomination_deadline', confirmedCandidates: 0 },
    to: { status: 'offering' },
  },
  {
    name: 'nominating -> cancelled',
    from: s('nominating'),
    event: { type: 'lead_returned', ballotsCast: 0 },
    to: cancelled,
  },
  {
    name: 'nominating ignores a majority',
    from: s('nominating'),
    event: { type: 'majority_reached' },
    to: undefined,
  },
  {
    name: 'voting -> confirming (majority)',
    from: s('voting'),
    event: { type: 'majority_reached' },
    to: { status: 'confirming' },
  },
  {
    name: 'voting -> confirming (deadline, one maximum)',
    from: s('voting'),
    event: { type: 'voting_deadline', quorum: true, tie: false },
    to: { status: 'confirming' },
  },
  {
    name: 'voting -> runoff (tie)',
    from: s('voting'),
    event: { type: 'voting_deadline', quorum: true, tie: true },
    to: { status: 'runoff', round: 2 },
  },
  {
    name: 'voting -> voting (extension once)',
    from: s('voting'),
    event: { type: 'voting_deadline', quorum: false, tie: false },
    to: { status: 'voting', extended: true },
  },
  {
    name: 'voting -> offering (no quorum after extension)',
    from: s('voting', 1, true),
    event: { type: 'voting_deadline', quorum: false, tie: false },
    to: { status: 'offering', extended: true },
  },
  {
    name: 'voting -> cancelled before the first ballot',
    from: s('voting'),
    event: { type: 'lead_returned', ballotsCast: 0 },
    to: cancelled,
  },
  {
    name: 'voting is not cancelled after a ballot',
    from: s('voting'),
    event: { type: 'lead_returned', ballotsCast: 1 },
    to: undefined,
  },
  {
    name: 'voting ignores the nomination deadline',
    from: s('voting'),
    event: { type: 'nomination_deadline', confirmedCandidates: 1 },
    to: undefined,
  },
  {
    name: 'runoff -> confirming (one maximum)',
    from: s('runoff', 2),
    event: { type: 'runoff_deadline', tie: false },
    to: { status: 'confirming', round: 2, tieBreak: false },
  },
  {
    name: 'runoff -> confirming (second tie)',
    from: s('runoff', 2),
    event: { type: 'runoff_deadline', tie: true },
    to: { status: 'confirming', round: 2, tieBreak: true },
  },
  {
    name: 'runoff cannot be cancelled',
    from: s('runoff', 2),
    event: { type: 'lead_returned', ballotsCast: 0 },
    to: undefined,
  },
  {
    name: 'confirming -> closed (elected)',
    from: s('confirming'),
    event: { type: 'offer_accepted' },
    to: { status: 'closed', outcome: 'elected' },
  },
  {
    name: 'confirming -> confirming (next candidate)',
    from: s('confirming'),
    event: { type: 'confirmation_declined', candidatesLeft: 1 },
    to: { status: 'confirming' },
  },
  {
    name: 'confirming -> offering (exhausted)',
    from: s('confirming'),
    event: { type: 'confirmation_declined', candidatesLeft: 0 },
    to: { status: 'offering' },
  },
  {
    name: 'confirming ignores senior_declined',
    from: s('confirming'),
    event: { type: 'senior_declined', membersLeft: 1 },
    to: undefined,
  },
  {
    name: 'offering -> closed (appointed_senior)',
    from: s('offering'),
    event: { type: 'offer_accepted' },
    to: { status: 'closed', outcome: 'appointed_senior' },
  },
  {
    name: 'offering -> offering (next by tenure)',
    from: s('offering'),
    event: { type: 'senior_declined', membersLeft: 2 },
    to: { status: 'offering' },
  },
  {
    name: 'offering -> closed (suspended)',
    from: s('offering'),
    event: { type: 'senior_declined', membersLeft: 0 },
    to: { status: 'closed', outcome: 'suspended', suspendTeam: true },
  },
  {
    name: 'offering ignores confirmation_declined',
    from: s('offering'),
    event: { type: 'confirmation_declined', candidatesLeft: 1 },
    to: undefined,
  },
  {
    name: 'closed is final',
    from: s('closed'),
    event: { type: 'offer_accepted' },
    to: undefined,
  },
  {
    name: 'cancelled is final',
    from: s('cancelled'),
    event: { type: 'nomination_deadline', confirmedCandidates: 1 },
    to: undefined,
  },
];

describe('leader vote machine (architecture 8.2)', () => {
  it.each(TABLE)('$name', ({ from, event, to }) => {
    const got = transition(from, event);
    if (to === undefined) {
      expect(got).toBeUndefined();
      return;
    }
    expect(got).toEqual({
      status: to.status,
      round: to.round ?? from.round,
      extended: to.extended ?? from.extended,
      outcome: to.outcome ?? null,
      tieBreak: to.tieBreak ?? false,
      suspendTeam: to.suspendTeam ?? false,
    });
  });

  it('every status is covered as a source in the table', () => {
    const sources = new Set(TABLE.map((r) => r.from.status));
    expect([...sources].sort()).toEqual([...VOTE_STATUSES].sort());
  });

  it('opening: nobody -> archive, one member -> sole_member, otherwise open', () => {
    expect(openingCase(0)).toBe('archive');
    expect(openingCase(1)).toBe('sole_member');
    expect(openingCase(2)).toBe('open');
  });

  it('quorum, requests and the majority follow the snapshot', () => {
    expect([1, 2, 3, 4, 5].map(quorumOf)).toEqual([1, 2, 2, 3, 3]);
    expect([1, 2, 3, 4, 5].map(requestsRequired)).toEqual([1, 1, 2, 2, 3]);
    expect(isMajority(2, 3)).toBe(true);
    expect(isMajority(2, 4)).toBe(false);
    expect(isMajority(3, 4)).toBe(true);
  });

  it('the lead is inactive only after more than 14 days', () => {
    const now = new Date('2026-03-20T00:00:00Z');
    expect(leadInactive(null, now)).toBe(false);
    expect(leadInactive(new Date('2026-03-06T00:00:00Z'), now)).toBe(false);
    expect(leadInactive(new Date('2026-03-05T23:59:59Z'), now)).toBe(true);
  });

  it('phase deadlines (C-16, C-18, C-19, C-29, 24 h offers)', () => {
    const opened = new Date('2026-03-01T00:00:00Z');
    const at = new Date('2026-03-02T05:00:00Z');
    const ms = (d: Date | null): number | null => (d === null ? null : d.getTime());
    expect(ms(phaseDeadline(s('nominating'), opened, opened))).toBe(
      opened.getTime() + NOMINATION_MS,
    );
    expect(ms(phaseDeadline(s('voting'), opened, at))).toBe(opened.getTime() + VOTING_MS);
    expect(ms(phaseDeadline(s('voting', 1, true), opened, at))).toBe(
      opened.getTime() + VOTING_MS + EXTENSION_MS,
    );
    expect(ms(phaseDeadline(s('runoff', 2), opened, at))).toBe(at.getTime() + RUNOFF_MS);
    expect(ms(phaseDeadline(s('confirming'), opened, at))).toBe(at.getTime() + OFFER_MS);
    expect(ms(phaseDeadline(s('offering'), opened, at))).toBe(at.getTime() + OFFER_MS);
    expect(phaseDeadline(s('closed'), opened, at)).toBeNull();
    expect(phaseDeadline(s('cancelled'), opened, at)).toBeNull();
  });

  it('open statuses', () => {
    expect(isOpenStatus('voting')).toBe(true);
    expect(isOpenStatus('closed')).toBe(false);
    expect(isOpenStatus('cancelled')).toBe(false);
  });
});
