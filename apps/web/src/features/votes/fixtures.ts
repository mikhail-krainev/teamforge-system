// Sample data for vote component tests (typed by the generated contract).
import { LEAD_ID, MEMBER_ID, sampleTeam } from '@/features/teams/fixtures';
import type { Team } from '@/features/teams/api';
import type { LeaderVote } from './api';

export const VOTE_ID = '0192f0a0-7c1e-7b3a-8d2f-00000000c0a1';
export const ANNA_ID = LEAD_ID;
export const BOB_ID = MEMBER_ID;
export const CAROL_ID = '0192f0a0-7c1e-7b3a-8d2f-0000000000cb';

export function voteTeam(overrides: Partial<Team> = {}): Team {
  const base = sampleTeam().members[0]!;
  const member = (userId: string, displayName: string) => ({
    ...base,
    userId,
    displayName,
    isLead: false,
  });
  return sampleTeam({
    status: 'voting',
    leadUserId: null,
    memberCount: 3,
    members: [
      member(ANNA_ID, 'Анна Смирнова'),
      member(BOB_ID, 'Борис Иванов'),
      member(CAROL_ID, 'Вера Орлова'),
    ],
    ...overrides,
  });
}

export function sampleVote(overrides: Partial<LeaderVote> = {}): LeaderVote {
  return {
    id: VOTE_ID,
    teamId: voteTeam().id,
    trigger: 'lead_left',
    status: 'nominating',
    round: 1,
    openedAt: '2026-01-01T10:00:00.000Z',
    phaseDeadline: new Date(Date.now() + 5 * 3_600_000 + 30 * 60_000).toISOString(),
    extended: false,
    eligibleCount: 3,
    quorum: 2,
    candidates: [],
    ballotsCast: 0,
    myBallotCast: false,
    canVote: true,
    canNominate: true,
    pendingOffer: null,
    outcome: null,
    ...overrides,
  };
}
