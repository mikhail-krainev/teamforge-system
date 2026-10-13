import { seatInput } from './teams.js';
import type { OperationRequest } from './operations.js';

/**
 * The 35 operations of slice 3 by module (docs/plan.md, "Покрытие операций по срезам"). Paths and
 * bodies come from docs/api/openapi.yaml; nothing here is invented.
 */
export const TEAMS_OPERATIONS = [
  'listTeams',
  'createTeam',
  'getTeam',
  'updateTeam',
  'listMyTeams',
  'addSeats',
  'updateSeat',
  'closeSeat',
  'startProject',
  'listTeamEvents',
  'createSeatOffer',
  'listTeamSeatOffers',
  'createJoinRequest',
  'listMySeatOffers',
  'acceptSeatOffer',
  'rejectSeatOffer',
  'createInvitation',
  'listInvitations',
  'revokeInvitation',
  'previewInvitation',
  'acceptInvitation',
  'leaveTeam',
  'listDepartures',
  'decideDeparture',
  'listLeaderVotes',
  'getLeaderVoteRequests',
  'requestLeaderVote',
  'nominateCandidate',
  'consentCandidacy',
  'withdrawCandidacy',
  'castBallot',
  'respondLeaderOffer',
] as const;

export const PLAYBOOKS_OPERATIONS = ['listProductTypes'] as const;
export const WORKSPACE_OPERATIONS = ['listNotifications', 'markNotificationsRead'] as const;

export const SLICE3_OPERATIONS = [
  ...PLAYBOOKS_OPERATIONS,
  ...TEAMS_OPERATIONS,
  ...WORKSPACE_OPERATIONS,
] as const;

export type Slice3Operation = (typeof SLICE3_OPERATIONS)[number];

/** Identifiers a request needs; unset ones are a well-formed id that exists nowhere. */
export interface TeamsContext {
  teamId?: string;
  seatId?: string;
  offerId?: string;
  invitationId?: string;
  departureId?: string;
  voteId?: string;
  userId?: string;
  token?: string;
}

const NOWHERE = '00000000-0000-4000-8000-000000000999';
/** A syntactically valid invitation token (43 base64url characters) that matches no invitation. */
export const UNKNOWN_TOKEN = 'A'.repeat(43);

type Resolved = Required<TeamsContext>;
type Builder = (c: Resolved) => OperationRequest;

const get =
  (url: (c: Resolved) => string): Builder =>
  (c) => ({ method: 'GET', url: url(c) });
const post =
  (url: (c: Resolved) => string, body?: (c: Resolved) => unknown): Builder =>
  (c) => ({ method: 'POST', url: url(c), body: body?.(c) });

const BUILDERS: Record<Slice3Operation, Builder> = {
  listProductTypes: get(() => '/v1/product-types'),
  listTeams: get(() => '/v1/teams'),
  createTeam: post(
    () => '/v1/teams',
    () => ({
      name: 'Operation team',
      description: 'Built by requestForTeams',
      timezone: 'Europe/Moscow',
      hoursPerWeek: 10,
      productTypeCode: 'web_service',
      seats: [seatInput()],
    }),
  ),
  getTeam: get((c) => `/v1/teams/${c.teamId}`),
  updateTeam: (c) => ({
    method: 'PATCH',
    url: `/v1/teams/${c.teamId}`,
    body: { name: 'Renamed team', version: 1 },
  }),
  listMyTeams: get(() => '/v1/me/teams'),
  addSeats: post(
    (c) => `/v1/teams/${c.teamId}/seats`,
    () => ({ seats: [seatInput({ roleCode: 'qa' })] }),
  ),
  updateSeat: (c) => ({
    method: 'PATCH',
    url: `/v1/teams/${c.teamId}/seats/${c.seatId}`,
    body: { version: 1, desired: true },
  }),
  closeSeat: (c) => ({ method: 'DELETE', url: `/v1/teams/${c.teamId}/seats/${c.seatId}` }),
  startProject: post((c) => `/v1/teams/${c.teamId}/start`),
  listTeamEvents: get((c) => `/v1/teams/${c.teamId}/events`),
  createSeatOffer: post(
    (c) => `/v1/teams/${c.teamId}/seat-offers`,
    (c) => ({ seatId: c.seatId, userId: c.userId }),
  ),
  listTeamSeatOffers: get((c) => `/v1/teams/${c.teamId}/seat-offers`),
  createJoinRequest: post(
    (c) => `/v1/teams/${c.teamId}/join-requests`,
    (c) => ({ seatId: c.seatId }),
  ),
  listMySeatOffers: get(() => '/v1/me/seat-offers'),
  acceptSeatOffer: post((c) => `/v1/seat-offers/${c.offerId}/acceptance`),
  rejectSeatOffer: post((c) => `/v1/seat-offers/${c.offerId}/rejection`),
  createInvitation: post(
    (c) => `/v1/teams/${c.teamId}/invitations`,
    (c) => ({ seatId: c.seatId }),
  ),
  listInvitations: get((c) => `/v1/teams/${c.teamId}/invitations`),
  revokeInvitation: (c) => ({
    method: 'DELETE',
    url: `/v1/teams/${c.teamId}/invitations/${c.invitationId}`,
  }),
  previewInvitation: post(
    () => '/v1/invitation-previews',
    (c) => ({ token: c.token }),
  ),
  acceptInvitation: post(
    () => '/v1/invitation-acceptances',
    (c) => ({ token: c.token }),
  ),
  leaveTeam: (c) => ({ method: 'DELETE', url: `/v1/teams/${c.teamId}/members/me` }),
  listDepartures: get((c) => `/v1/teams/${c.teamId}/departures`),
  decideDeparture: post(
    (c) => `/v1/teams/${c.teamId}/departures/${c.departureId}/decision`,
    () => ({ decision: 'continue' }),
  ),
  listLeaderVotes: get((c) => `/v1/teams/${c.teamId}/leader-votes`),
  getLeaderVoteRequests: get((c) => `/v1/teams/${c.teamId}/leader-vote-requests`),
  requestLeaderVote: post((c) => `/v1/teams/${c.teamId}/leader-vote-requests`),
  nominateCandidate: post(
    (c) => `/v1/teams/${c.teamId}/leader-votes/${c.voteId}/candidates`,
    (c) => ({ userId: c.userId }),
  ),
  consentCandidacy: post(
    (c) => `/v1/teams/${c.teamId}/leader-votes/${c.voteId}/candidates/${c.userId}/consent`,
  ),
  withdrawCandidacy: post(
    (c) => `/v1/teams/${c.teamId}/leader-votes/${c.voteId}/candidates/me/withdrawal`,
  ),
  castBallot: post(
    (c) => `/v1/teams/${c.teamId}/leader-votes/${c.voteId}/ballots`,
    (c) => ({ candidateUserId: c.userId }),
  ),
  respondLeaderOffer: post(
    (c) => `/v1/teams/${c.teamId}/leader-votes/${c.voteId}/offer-responses`,
    () => ({ accept: true }),
  ),
  listNotifications: get(() => '/v1/me/notifications'),
  markNotificationsRead: post(
    () => '/v1/me/notifications/read-marks',
    (c) => ({ ids: [c.offerId] }),
  ),
};

/** A syntactically valid request for each slice 3 operation; the response is what the test is about. */
export function requestForTeams(
  operationId: Slice3Operation,
  context: TeamsContext = {},
): OperationRequest {
  return BUILDERS[operationId]({
    teamId: context.teamId ?? NOWHERE,
    seatId: context.seatId ?? NOWHERE,
    offerId: context.offerId ?? NOWHERE,
    invitationId: context.invitationId ?? NOWHERE,
    departureId: context.departureId ?? NOWHERE,
    voteId: context.voteId ?? NOWHERE,
    userId: context.userId ?? NOWHERE,
    token: context.token ?? UNKNOWN_TOKEN,
  });
}
