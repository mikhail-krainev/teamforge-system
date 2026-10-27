import { describe, expect, it } from 'vitest';
import type { CompletionSnapshot } from '../../../workspace/public.js';
import {
  type CreditedRole,
  individualBadges,
  type ProjectFacts,
  seriesStepsLost,
  teamBonusRecipients,
  type UserStats,
} from './award-rules.js';

/*
 * M-7 of the slice 7 review: fast unit tests of the badges (FR-REW-05 to FR-REW-10) that were covered by the
 * database tests only.
 */

const stats = (change: Partial<UserStats> = {}): UserStats => ({
  distinctRosters: 0,
  roles: 0,
  productTypes: 0,
  lastOverdue: [],
  ...change,
});
const project = (change: Partial<ProjectFacts> = {}): ProjectFacts => ({
  overdueDays: 3,
  closedDeficit: false,
  ...change,
});

describe('individualBadges: the series (FR-REW-05)', () => {
  it.each([
    [0, []],
    [1, ['projects_1']],
    [2, ['projects_1']],
    [3, ['projects_1', 'projects_2']],
    [4, ['projects_1', 'projects_2']],
    [5, ['projects_1', 'projects_2', 'projects_3']],
    [9, ['projects_1', 'projects_2', 'projects_3']],
    [10, ['projects_1', 'projects_2', 'projects_3', 'projects_4']],
  ])('%i distinct rosters give %j', (distinctRosters, codes) => {
    expect(individualBadges(stats({ distinctRosters }), project())).toEqual(codes);
  });

  it.each([
    [2, []],
    [3, ['roles_1']],
    [4, ['roles_1']],
    [5, ['roles_1', 'roles_2']],
  ])('%i credited roles give %j', (roles, codes) => {
    expect(individualBadges(stats({ roles }), project())).toEqual(codes);
  });

  it.each([
    [1, []],
    [2, ['product_types_1']],
    [3, ['product_types_1']],
    [4, ['product_types_1', 'product_types_2']],
  ])('%i product types give %j', (productTypes, codes) => {
    expect(individualBadges(stats({ productTypes }), project())).toEqual(codes);
  });
});

describe('individualBadges: "В срок" (FR-REW-07)', () => {
  it('a project without a delay gives on_time', () => {
    expect(individualBadges(stats(), project({ overdueDays: 0 }))).toEqual(['on_time']);
  });

  it('a delay of one day gives nothing', () => {
    expect(individualBadges(stats(), project({ overdueDays: 1 }))).toEqual([]);
  });
});

describe('individualBadges: "Три в срок подряд" (FR-REW-08)', () => {
  const streak = (lastOverdue: number[]): string[] =>
    individualBadges(stats({ lastOverdue }), project()).filter((code) => code === 'on_time_streak');

  it('three last projects without a delay give the badge', () => {
    expect(streak([0, 0, 0])).toEqual(['on_time_streak']);
  });

  it('two projects are not enough, a delay in any of the three breaks the streak', () => {
    expect(streak([0, 0])).toEqual([]);
    expect(streak([1, 0, 0])).toEqual([]);
    expect(streak([0, 2, 0])).toEqual([]);
    expect(streak([0, 0, 1])).toEqual([]);
  });

  it('only the three newest projects count: an older delay does not break the streak', () => {
    expect(streak([0, 0, 0, 5])).toEqual(['on_time_streak']);
  });

  it('does not depend on the delay of the project that is credited now', () => {
    const codes = individualBadges(stats({ lastOverdue: [0, 0, 0] }), project({ overdueDays: 4 }));
    expect(codes).toEqual(['on_time_streak']);
  });
});

describe('individualBadges: "Закрыл дефицит" (FR-REW-09) and the order of the codes', () => {
  it('a credited deficit role of this project gives closed_deficit', () => {
    expect(individualBadges(stats(), project({ closedDeficit: true }))).toEqual(['closed_deficit']);
    expect(individualBadges(stats(), project({ closedDeficit: false }))).toEqual([]);
  });

  it('every earned badge is listed: the series, then on_time, the streak and the deficit', () => {
    const everything = individualBadges(
      stats({ distinctRosters: 1, roles: 3, productTypes: 2, lastOverdue: [0, 0, 0] }),
      project({ overdueDays: 0, closedDeficit: true }),
    );
    expect(everything).toEqual([
      'projects_1',
      'roles_1',
      'product_types_1',
      'on_time',
      'on_time_streak',
      'closed_deficit',
    ]);
  });
});

type Snapshot = CompletionSnapshot;
type Seat = Snapshot['roster']['seats'][number];

const seat = (change: Partial<Seat> = {}): Seat => ({
  seatId: 's1',
  roleCode: 'backend',
  desired: true,
  holderUserId: 'u1',
  ...change,
});

/** Active at the completion: u1, u2 and u3; `u4` left early (listed as departed, not in the roster). */
function snapshotWith(seats: Seat[]): Snapshot {
  const members = ['u1', 'u2', 'u3'].map((userId) => ({
    userId,
    isLead: false,
    joinedAt: '2026-03-01T00:00:00.000Z',
    joinedVia: 'queue',
    roles: [{ roleCode: 'backend', deficitAtJoin: false }],
  }));
  return {
    teamId: 't1',
    completedAt: '2026-04-01T00:00:00.000Z',
    startedAt: '2026-03-01T00:00:00.000Z',
    plannedEndAt: '2026-04-01T00:00:00.000Z',
    overdueDays: 0,
    productType: 'web',
    releaseUrl: null,
    repositoryId: 1,
    roster: { members, seats, departedUserIds: ['u4'] },
    stages: [],
    contributions: [],
    participationConfirms: [],
  };
}

const credit = (userId: string, roleCode = 'backend', deficitAtJoin = true): CreditedRole => ({
  userId,
  roleCode,
  deficitAtJoin,
});

describe('teamBonusRecipients: "Закрытая вакансия" (FR-REW-10)', () => {
  it('a desired role closed by a credited holder with a deficit: everybody active gets the bonus', () => {
    const snap = snapshotWith([seat()]);
    expect(teamBonusRecipients(snap, [credit('u1')])).toEqual(['u1', 'u2', 'u3']);
  });

  it('the member without a credit of his own gets the bonus too; the early leaver does not', () => {
    const recipients = teamBonusRecipients(snapshotWith([seat()]), [credit('u1')]);
    expect(recipients).toContain('u3');
    expect(recipients).not.toContain('u4');
  });

  it('a desired role without a deficit gives nothing', () => {
    const none = teamBonusRecipients(snapshotWith([seat()]), [credit('u1', 'backend', false)]);
    expect(none).toEqual([]);
  });

  it('a deficit role that is not desired gives nothing', () => {
    const none = teamBonusRecipients(snapshotWith([seat({ desired: false })]), [credit('u1')]);
    expect(none).toEqual([]);
  });

  it('a deficit without a credit of that role gives nothing (no credited rows, or another role)', () => {
    const snap = snapshotWith([seat()]);
    expect(teamBonusRecipients(snap, [])).toEqual([]);
    expect(teamBonusRecipients(snap, [credit('u1', 'qa')])).toEqual([]);
  });

  it('the credit must belong to the holder of the seat, not to another member', () => {
    expect(teamBonusRecipients(snapshotWith([seat()]), [credit('u2')])).toEqual([]);
  });

  it('a seat without a holder gives nothing; a holder who left early has no credit in the roster', () => {
    expect(
      teamBonusRecipients(snapshotWith([seat({ holderUserId: null })]), [credit('u1')]),
    ).toEqual([]);
    expect(
      teamBonusRecipients(snapshotWith([seat({ holderUserId: 'u4' })]), [credit('u2')]),
    ).toEqual([]);
  });

  it('one closed seat among several is enough', () => {
    const seats = [
      seat({ seatId: 's1', desired: false }),
      seat({ seatId: 's2', roleCode: 'qa', holderUserId: 'u2' }),
    ];
    expect(teamBonusRecipients(snapshotWith(seats), [credit('u2', 'qa')])).toEqual([
      'u1',
      'u2',
      'u3',
    ]);
  });
});

describe('seriesStepsLost: the steps a revocation took below the threshold (FR-REW-12, M-4)', () => {
  it('three projects, three roles, two types: nothing reached is lost; the steps above are listed', () => {
    const lost = seriesStepsLost(stats({ distinctRosters: 3, roles: 3, productTypes: 2 }));
    expect(lost).toEqual(['projects_3', 'projects_4', 'roles_2', 'product_types_2']);
  });

  it('a revocation from three projects to two loses "Трое в строю" but keeps "Первый релиз"', () => {
    const lost = seriesStepsLost(stats({ distinctRosters: 2, roles: 1, productTypes: 1 }));
    expect(lost).toContain('projects_2');
    expect(lost).not.toContain('projects_1');
    expect(lost).toContain('roles_1');
    expect(lost).toContain('product_types_1');
  });

  it('no credited project left: every step of every series is lost', () => {
    expect(seriesStepsLost(stats())).toHaveLength(8);
  });
});
