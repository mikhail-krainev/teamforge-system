import { describe, expect, it } from 'vitest';
import { type JoinFacts, joinRefusal } from './join-rules.js';

const base: JoinFacts = {
  teamStatus: 'forming',
  memberCount: 3,
  seatStatus: 'open',
  seatRole: 'qa',
  isMember: false,
  heldRoles: [],
  activeProjects: 0,
};

describe('joinRefusal', () => {
  it('allows a new member into a team with room', () => {
    expect(joinRefusal(base)).toBeUndefined();
  });

  it.each([
    [{ teamStatus: 'completed' }, 'INVALID_STATE'],
    [{ teamStatus: 'voting' }, 'INVALID_STATE'],
    [{ seatStatus: 'filled' }, 'SEAT_TAKEN'],
    [{ seatStatus: 'closed' }, 'SEAT_NOT_OPEN'],
    [{ activeProjects: 2 }, 'PROJECT_LIMIT'],
    [{ memberCount: 8 }, 'TEAM_FULL'],
  ] as const)('refuses %j with %s', (patch, code) => {
    expect(joinRefusal({ ...base, ...patch })).toBe(code);
  });

  it('FR-TEAM-07: a member may take a second role without counting as a new member', () => {
    const member = {
      ...base,
      isMember: true,
      heldRoles: ['backend'],
      memberCount: 8,
      activeProjects: 2,
    };
    expect(joinRefusal(member)).toBeUndefined();
  });

  it('FR-TEAM-07: the same role twice is ALREADY_MEMBER, a third role is ROLE_LIMIT', () => {
    expect(joinRefusal({ ...base, isMember: true, heldRoles: ['qa'] })).toBe('ALREADY_MEMBER');
    expect(joinRefusal({ ...base, isMember: true, heldRoles: ['backend', 'pm'] })).toBe(
      'ROLE_LIMIT',
    );
  });

  it('a taken seat is reported before the size of the team', () => {
    expect(joinRefusal({ ...base, seatStatus: 'filled', memberCount: 8 })).toBe('SEAT_TAKEN');
  });
});
