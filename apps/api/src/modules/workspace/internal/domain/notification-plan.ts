import type { NotificationDraft, NotificationType } from '../notifications/notification-types.js';

/** What the planner needs to know about a team; read lazily and only for events that need it. */
export interface TeamAudience {
  leadUserId: string | null;
  /** Active members including the lead. */
  memberUserIds: string[];
}

export interface PlanEvent {
  id: string;
  /** `module.type`. */
  name: string;
  payload: Record<string, unknown>;
}

export type AudienceLookup = (teamId: string) => Promise<TeamAudience | null>;

const str = (value: unknown): string | undefined =>
  typeof value === 'string' && value !== '' ? value : undefined;

function draft(
  userId: string,
  type: NotificationType,
  dedupeKey: string,
  payload: NotificationDraft['payload'],
): NotificationDraft {
  return { userId, type, dedupeKey, payload };
}

type Planner = (
  event: PlanEvent,
  teamId: string | undefined,
  audience: AudienceLookup,
) => Promise<NotificationDraft[]>;

const leadOf = async (teamId: string | undefined, audience: AudienceLookup) =>
  teamId === undefined ? undefined : (await audience(teamId))?.leadUserId;

const planOffer: Planner = async ({ payload: p }, teamId, audience) => {
  const offerId = str(p['offerId']);
  const userId = str(p['userId']);
  if (teamId === undefined || offerId === undefined || userId === undefined) return [];
  const ids = { offerId, teamId, seatId: str(p['seatId']) ?? null };
  if (p['direction'] === 'lead_to_user') {
    return [draft(userId, 'seat_offer', `seat_offer:${offerId}`, ids)];
  }
  const lead = await leadOf(teamId, audience);
  return lead ? [draft(lead, 'join_request', `join_request:${offerId}`, ids)] : [];
};

/** Something happened to a member: the lead hears about it (unless he did it himself). */
function planForLead(type: NotificationType): Planner {
  return async (event, teamId, audience) => {
    const userId = str(event.payload['userId']);
    const lead = await leadOf(teamId, audience);
    if (teamId === undefined || !lead || lead === userId) return [];
    return [draft(lead, type, `${type}:${event.id}`, { teamId, userId: userId ?? null })];
  };
}

/** Every member except the lead (he made the change himself, or is alone in a new team). */
function planForMembers(type: NotificationType, keyOf: (event: PlanEvent) => string): Planner {
  return async (event, teamId, audience) => {
    const team = teamId === undefined ? null : await audience(teamId);
    if (teamId === undefined || team === null) return [];
    const ids = { teamId, seatId: str(event.payload['seatId']) ?? null };
    return team.memberUserIds
      .filter((id) => id !== team.leadUserId)
      .map((id) => draft(id, type, keyOf(event), ids));
  };
}

const planLeadChanged: Planner = async (event, teamId, audience) => {
  const team = teamId === undefined ? null : await audience(teamId);
  if (teamId === undefined || team === null) return [];
  const toUserId = str(event.payload['toUserId']) ?? team.leadUserId ?? null;
  return team.memberUserIds.map((id) =>
    draft(id, 'lead_changed', `lead_changed:${event.id}`, { teamId, toUserId }),
  );
};

const planAutoAdded: Planner = async ({ id, payload: p }, teamId) => {
  const userId = str(p['userId']);
  if (userId === undefined || teamId === undefined) return [];
  const ids = { teamId, seatId: str(p['seatId']) ?? null };
  return [draft(userId, 'auto_added', `auto_added:${id}`, ids)];
};

/** Voting: everybody learns that it opened and closed; the candidate gets the leader offer. */
const planVote: Planner = async (event, teamId, audience) => {
  const voteId = str(event.payload['voteId']);
  const status = str(event.payload['status']);
  if (teamId === undefined || voteId === undefined || status === undefined) return [];
  const ids = { teamId, voteId };
  if (status === 'offering' || status === 'confirming') {
    const candidate = str(event.payload['candidateUserId']);
    return candidate
      ? [draft(candidate, 'leader_offer', `leader_offer:${voteId}:${status}`, ids)]
      : [];
  }
  const type = status === 'nominating' ? 'vote_opened' : status === 'closed' ? 'vote_closed' : null;
  if (type === null) return [];
  const team = await audience(teamId);
  return (team?.memberUserIds ?? []).map((id) => draft(id, type, `${type}:${voteId}`, ids));
};

/** Reason of `github.repo_unlinked` when the lead himself removed the link: nobody needs to be told. */
const UNLINKED_BY_LEAD = 'lead';

/** FR-GH-07: the repository was unlinked by an event of GitHub, the lead is told why (a code, not a name). */
const planRepoUnlinked: Planner = async ({ id, payload: p }, teamId, audience) => {
  const reason = str(p['reason']);
  if (teamId === undefined || reason === undefined || reason === UNLINKED_BY_LEAD) return [];
  const lead = await leadOf(teamId, audience);
  return lead ? [draft(lead, 'repo_unlinked', `repo_unlinked:${id}`, { teamId, reason })] : [];
};

/**
 * SEC-04: the batch of reviews of a project was published. One notification per subject, with the project
 * only (never an author or a count); the text is here because the feed shows it as it is. A subject whose
 * reviews were withheld gets no event, hence no notification.
 */
const planReviewsPublished: Planner = async ({ payload: p }, teamId) => {
  const userId = str(p['userId']);
  if (teamId === undefined || userId === undefined) return [];
  const teamName = str(p['teamName']);
  const text =
    teamName === undefined
      ? 'Получены отзывы по проекту'
      : `Получены отзывы по проекту «${teamName}»`;
  return [
    draft(userId, 'reviews_published', `reviews_published:${teamId}`, {
      teamId,
      teamName: teamName ?? null,
      text,
    }),
  ];
};

const PLANNERS: Record<string, Planner> = {
  'teams.offer_created': planOffer,
  'teams.invitation_accepted': planForLead('invitation_accepted'),
  'teams.member_joined': planForLead('member_joined'),
  'teams.member_left': planForLead('member_left'),
  'teams.seat_opened': planForMembers(
    'seat_opened',
    (e) => `seat_opened:${str(e.payload['seatId'])}`,
  ),
  'teams.team_started': planForMembers('team_started', (e) => `team_started:${e.id}`),
  'teams.lead_changed': planLeadChanged,
  'teams.vote_updated': planVote,
  'matching.auto_added': planAutoAdded,
  'github.repo_unlinked': planRepoUnlinked,
  'profiles.reviews_published': planReviewsPublished,
};

/**
 * Which notifications an outbox event produces (FR-WORK-19). The event is only the occasion:
 * recipients come from the current team state, so a late or repeated delivery stays correct
 * (architecture 4, re-read and reconcile). Payloads hold ids only.
 */
export function planNotifications(
  event: PlanEvent,
  audience: AudienceLookup,
): Promise<NotificationDraft[]> {
  const planner = PLANNERS[event.name];
  if (planner === undefined) return Promise.resolve([]);
  return planner(event, str(event.payload['teamId']), audience);
}
