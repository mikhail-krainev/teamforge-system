import { randomUUID } from 'node:crypto';
import { expect } from 'vitest';
import { githubIdentity } from '../fakes/github-server.js';
import { expectMatchesContract } from '../helpers/contract.js';
import type { InjectResponse } from '../helpers/http.js';
import { waitFor } from '../helpers/infra.js';
import type { UserFixture } from './index.js';
import type { World } from './world.js';

/**
 * Slice 3 fixtures (docs/plan.md, "Фикстуры": `team`, `teamWithOpenSeat`, `leaderVote`).
 *
 * Deviation from the plan, on purpose: the plan says builders insert rows directly. The slice 3
 * tables do not exist while these tests are written, and the computed fields (`member_count`,
 * `seat_count`, `deficit_*`) must come from the production code anyway, so the builders go through
 * the public API (createTeam, addSeats, createSeatOffer, acceptSeatOffer, startProject, leaveTeam,
 * the leader-vote operations). Users are inserted directly (`World.createUser`) with a GitHub identity.
 */

/** Roles of the seeded catalog (apps/api/drizzle/0004_seed_catalog.sql) that fixtures put on seats. */
export const TEAM_ROLES = ['backend', 'frontend', 'pm', 'designer', 'qa', 'devops'];
export const PRODUCT_TYPE = 'web_service';

const HOUR = 3_600_000;
export const DAY = 24 * HOUR;

export interface SeatDto {
  id: string;
  roleCode: string;
  desired: boolean;
  minLevel: string;
  minHours: number;
  stack: string[];
  ordinal: number;
  status: 'open' | 'filled' | 'closed';
  holderUserId: string | null;
  version: number;
}

export interface MemberDto {
  userId: string;
  displayName: string;
  status: 'active' | 'left' | 'removed';
  joinedVia: string;
  joinedAt: string;
  trialUntil: string | null;
  roles: string[];
  isLead: boolean;
}

export interface TeamDto {
  id: string;
  name: string;
  description: string;
  timezone: string;
  hoursPerWeek: number;
  productTypeCode: string;
  playbookId: string;
  playbookVersion: string;
  leadUserId: string | null;
  status: 'forming' | 'active' | 'voting' | 'suspended' | 'completed' | 'archived';
  startedAt?: string | null;
  plannedEndAt?: string | null;
  memberCount: number;
  seats: SeatDto[];
  members: MemberDto[];
  version: number;
}

export interface OfferDto {
  id: string;
  teamId: string;
  seatId: string;
  roleCode: string;
  direction: 'lead_to_user' | 'user_to_lead';
  userId: string;
  status: 'pending' | 'accepted' | 'rejected' | 'expired' | 'cancelled';
  expiresAt: string;
}

export interface VoteCandidateDto {
  userId: string;
  confirmed: boolean;
  withdrawn: boolean;
  votes: number | null;
}

export interface VoteDto {
  id: string;
  teamId: string;
  trigger: 'lead_left' | 'lead_deleted' | 'lead_inactive';
  status: 'nominating' | 'voting' | 'runoff' | 'confirming' | 'offering' | 'closed' | 'cancelled';
  round: number;
  phaseDeadline: string | null;
  extended: boolean;
  eligibleCount: number;
  quorum: number;
  candidates: VoteCandidateDto[];
  ballotsCast: number;
  myBallotCast: boolean;
  canVote: boolean;
  canNominate: boolean;
  pendingOffer?: { userId: string; kind: string; expiresAt: string } | null;
  outcome?: string | null;
  winnerUserId?: string | null;
}

export interface InvitationDto {
  id: string;
  seatId: string;
  roleCode: string;
  status: 'active' | 'used' | 'revoked' | 'expired';
  expiresAt: string;
}

export interface DepartureDto {
  id: string;
  userId: string;
  seatIds: string[];
  decision: 'pending' | 'replace' | 'continue';
  dueAt: string;
  unassignedItemIds: string[];
}

/** A valid `SeatInput` (FR-TEAM-02). */
export function seatInput(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    roleCode: 'backend',
    desired: false,
    minLevel: 'junior',
    minHours: 6,
    stack: ['typescript'],
    count: 1,
    ...overrides,
  };
}

/** A valid `TeamCreate` body. */
export function teamInput(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    name: `Team ${randomUUID().slice(0, 8)}`,
    description: 'A team for the slice 3 tests',
    timezone: 'Europe/Moscow',
    hoursPerWeek: 10,
    productTypeCode: PRODUCT_TYPE,
    ...overrides,
  };
}

/** A person with a linked GitHub account and a recorded consent: the only kind that may join (FR-AUTH-05). */
export function githubUser(world: World, label: string): Promise<UserFixture> {
  const unique = `${label}-${nextSerial()}`;
  return world.createUser(unique, { github: githubIdentity(`${unique}-${world.runId}`) });
}

/** A person without a linked GitHub account (the GITHUB_REQUIRED cases). */
export function userWithoutGithub(world: World, label: string): Promise<UserFixture> {
  return world.createUser(`${label}-${nextSerial()}`);
}

/** Labels repeat between builders (`lead`, `member-0`); the serial keeps every user row distinct. */
let serial = 0;
const nextSerial = (): number => {
  serial += 1;
  return serial;
};

export function manyGithubUsers(
  world: World,
  prefix: string,
  count: number,
): Promise<UserFixture[]> {
  return Promise.all(Array.from({ length: count }, (_, i) => githubUser(world, `${prefix}-${i}`)));
}

/** Asserts the status and (for documented statuses) the contract schema, returns the JSON body. */
export function expectOk<T>(operationId: string, response: InjectResponse, status: number): T {
  expect(response.statusCode, `${operationId}: ${response.body}`).toBe(status);
  expectMatchesContract(operationId, response);
  return (response.body === '' ? undefined : response.json()) as T;
}

export interface TeamFixture {
  id: string;
  lead: UserFixture;
  /** Active members other than the lead, in join order. */
  members: UserFixture[];
  /** Every seat of the team at the end of the build (re-read from `getTeam`). */
  seats: SeatDto[];
  openSeats: SeatDto[];
  dto: TeamDto;
}

export interface TeamOptions {
  /** Active members including the lead (default 1: only the creator). */
  members?: number;
  /** Open seats left after the members joined (default 2). */
  openSeats?: number;
  status?: 'forming' | 'active';
  lead?: UserFixture;
  /** Role of the open seats (default: cycles through TEAM_ROLES). */
  roleCode?: string;
  name?: string;
  /** Members take the seats of the planned roles, not the first seats the API lists (it lists by role code). */
  joinPlannedRoles?: boolean;
}

const roleAt = (index: number, fixed?: string): string =>
  fixed ?? TEAM_ROLES[index % TEAM_ROLES.length] ?? 'backend';

async function readTeam(world: World, viewer: UserFixture, teamId: string): Promise<TeamDto> {
  return expectOk<TeamDto>('getTeam', await world.as(viewer).get(`/v1/teams/${teamId}`), 200);
}

/** Lead sends an offer for `seatId` to `user`, the user accepts: a member through the production path. */
export async function joinThroughOffer(
  world: World,
  lead: UserFixture,
  teamId: string,
  seatId: string,
  user: UserFixture,
): Promise<OfferDto> {
  const offer = expectOk<OfferDto>(
    'createSeatOffer',
    await world.as(lead).post(`/v1/teams/${teamId}/seat-offers`, { seatId, userId: user.id }),
    201,
  );
  expectOk(
    'acceptSeatOffer',
    await world.as(user).post(`/v1/seat-offers/${offer.id}/acceptance`),
    200,
  );
  return offer;
}

/**
 * `team({ status, members, seats })` of the plan: a team led by a fresh GitHub user, `members - 1`
 * further members who joined through offers, `openSeats` open seats, optionally started.
 */
export async function team(world: World, options: TeamOptions = {}): Promise<TeamFixture> {
  const lead = options.lead ?? (await githubUser(world, 'lead'));
  const memberCount = options.members ?? 1;
  const openCount = options.openSeats ?? 2;
  const seatTotal = memberCount - 1 + openCount;
  const seats = Array.from({ length: seatTotal }, (_, i) =>
    seatInput({ roleCode: roleAt(i, i < memberCount - 1 ? undefined : options.roleCode) }),
  );
  const created = expectOk<TeamDto>(
    'createTeam',
    await world
      .as(lead)
      .post('/v1/teams', teamInput({ ...(options.name ? { name: options.name } : {}), seats })),
    201,
  );
  const members: UserFixture[] = [];
  const plannedRoles = seats.slice(0, memberCount - 1).map((seat) => String(seat['roleCode']));
  const free = [...created.seats];
  const joining = options.joinPlannedRoles
    ? plannedRoles.flatMap((role) => {
        const at = free.findIndex((seat) => seat.roleCode === role);
        return at < 0 ? [] : free.splice(at, 1);
      })
    : created.seats.slice(0, memberCount - 1);
  for (const [i, seat] of joining.entries()) {
    const member = await githubUser(world, `member-${i}`);
    await joinThroughOffer(world, lead, created.id, seat.id, member);
    members.push(member);
  }
  if (options.status === 'active') {
    expectOk('startProject', await world.as(lead).post(`/v1/teams/${created.id}/start`), 200);
  }
  const dto = await readTeam(world, lead, created.id);
  return {
    id: created.id,
    lead,
    members,
    seats: dto.seats,
    openSeats: dto.seats.filter((s) => s.status === 'open'),
    dto,
  };
}

export interface TeamWithOpenSeatOptions extends TeamOptions {
  /** People who each hold a pending offer from the lead (default 1). */
  candidates?: number;
}

export interface TeamWithOpenSeat extends TeamFixture {
  /** The first open seat; offers are spread over the open seats round-robin. */
  seat: SeatDto;
  candidates: UserFixture[];
  /** `offers[i]` is the pending offer of `candidates[i]`, on `openSeats[i % openSeats.length]`. */
  offers: OfferDto[];
}

/** `teamWithOpenSeat({ candidates })`: open seats and one pending lead-to-user offer per candidate. */
export async function teamWithOpenSeat(
  world: World,
  options: TeamWithOpenSeatOptions = {},
): Promise<TeamWithOpenSeat> {
  const base = await team(world, { ...options, openSeats: options.openSeats ?? 1 });
  const candidates = await manyGithubUsers(world, 'candidate', options.candidates ?? 1);
  const offers: OfferDto[] = [];
  for (const [i, candidate] of candidates.entries()) {
    const seat = base.openSeats[i % base.openSeats.length];
    if (!seat) throw new Error('teamWithOpenSeat: no open seat');
    offers.push(
      expectOk<OfferDto>(
        'createSeatOffer',
        await world
          .as(base.lead)
          .post(`/v1/teams/${base.id}/seat-offers`, { seatId: seat.id, userId: candidate.id }),
        201,
      ),
    );
  }
  const seat = base.openSeats[0];
  if (!seat) throw new Error('teamWithOpenSeat: no open seat');
  return { ...base, seat, candidates, offers };
}

export type VotePhase = 'nominating' | 'voting' | 'runoff' | 'confirming' | 'offering';

export interface LeaderVoteOptions {
  phase: VotePhase;
  /** Members of the team before the lead leaves, lead included (default depends on the phase). */
  members?: number;
}

export interface LeaderVoteFixture {
  team: TeamFixture;
  /** The lead who left and so opened the vote. */
  formerLead: UserFixture;
  /** The people who were eligible when the vote opened (the former members, lead excluded). */
  eligible: UserFixture[];
  voteId: string;
  vote: VoteDto;
}

const DEFAULT_MEMBERS: Record<VotePhase, number> = {
  nominating: 4,
  voting: 4,
  confirming: 4,
  offering: 4,
  runoff: 5,
};

export async function currentVote(
  world: World,
  viewer: UserFixture,
  teamId: string,
): Promise<VoteDto> {
  const page = expectOk<{ items: VoteDto[] }>(
    'listLeaderVotes',
    await world.as(viewer).get(`/v1/teams/${teamId}/leader-votes`),
    200,
  );
  const first = page.items[0];
  if (!first) throw new Error('no leader vote on the team');
  return first;
}

/** Moves the shared FakeClock and lets the worker's `vote-deadline-scan` (architecture 8.3) act. */
export async function passDeadline(
  world: World,
  viewer: UserFixture,
  teamId: string,
  ms: number,
): Promise<VoteDto> {
  const clock = world.options.clock;
  if (!clock) throw new Error('passDeadline needs World.start({ clock })');
  const before = await currentVote(world, viewer, teamId);
  clock.advance(ms);
  await world.runMaintenance('vote-deadline-scan');
  return waitFor(async () => {
    const now = await currentVote(world, viewer, teamId);
    return now.status !== before.status ||
      now.round !== before.round ||
      now.extended !== before.extended
      ? now
      : false;
  }, 20_000);
}

async function nominate(
  world: World,
  t: TeamFixture,
  voteId: string,
  who: UserFixture,
): Promise<void> {
  const base = `/v1/teams/${t.id}/leader-votes/${voteId}/candidates`;
  expectOk('nominateCandidate', await world.as(who).post(base, { userId: who.id }), 201);
  expectOk('consentCandidacy', await world.as(who).post(`${base}/${who.id}/consent`), 200);
}

export async function ballot(
  world: World,
  t: TeamFixture,
  voteId: string,
  voter: UserFixture,
  candidate: UserFixture,
): Promise<VoteDto> {
  return expectOk<VoteDto>(
    'castBallot',
    await world
      .as(voter)
      .post(`/v1/teams/${t.id}/leader-votes/${voteId}/ballots`, { candidateUserId: candidate.id }),
    201,
  );
}

/**
 * `leaderVote({ phase })`: a started team whose lead leaves (FR-TEAM-14), driven through the
 * documented phases with the FakeClock (needs `World.start({ clock })`, architecture 8.2):
 *  nominating - just opened; voting - one candidate consented, nomination period over;
 *  runoff - two candidates tied 2:2 among 4 eligible, voting period over;
 *  confirming - one candidate won by more than N/2; offering - nobody was nominated.
 */
export async function leaderVote(
  world: World,
  options: LeaderVoteOptions,
): Promise<LeaderVoteFixture> {
  const total = options.members ?? DEFAULT_MEMBERS[options.phase];
  const t = await team(world, { members: total, openSeats: 1, status: 'active' });
  expectOk('leaveTeam', await world.as(t.lead).delete(`/v1/teams/${t.id}/members/me`), 204);
  const viewer = t.members[0];
  if (!viewer) throw new Error('leaderVote needs at least two members');
  const opened = await currentVote(world, viewer, t.id);
  const out = (vote: VoteDto): LeaderVoteFixture => ({
    team: t,
    formerLead: t.lead,
    eligible: t.members,
    voteId: vote.id,
    vote,
  });
  if (options.phase === 'nominating') return out(opened);
  const [b, c, d, e] = t.members;
  if (!b || !c || !d) throw new Error('leaderVote needs at least three members');
  if (options.phase === 'offering')
    return out(await passDeadline(world, viewer, t.id, DAY + 60_000));
  await nominate(world, t, opened.id, b);
  if (options.phase === 'runoff') await nominate(world, t, opened.id, c);
  let vote = await passDeadline(world, viewer, t.id, DAY + 60_000);
  expect(vote.status).toBe('voting');
  if (options.phase === 'voting') return out(vote);
  if (options.phase === 'confirming') {
    await ballot(world, t, opened.id, b, b);
    vote = await ballot(world, t, opened.id, c, b);
    return out(vote);
  }
  if (!e) throw new Error('runoff needs four eligible members');
  await ballot(world, t, opened.id, b, b);
  await ballot(world, t, opened.id, c, c);
  await ballot(world, t, opened.id, d, b);
  await ballot(world, t, opened.id, e, c);
  vote = await passDeadline(world, viewer, t.id, 72 * HOUR);
  return out(vote);
}
