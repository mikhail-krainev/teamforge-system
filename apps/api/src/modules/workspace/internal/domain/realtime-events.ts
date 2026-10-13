import type { RealtimeChannel, RealtimeEventMap, RealtimeEventType } from 'shared/realtime';

/** A realtime message to publish: an invalidation signal, ids and statuses only (ADR-0011). */
export interface RealtimeSignal {
  channel: RealtimeChannel;
  type: RealtimeEventType;
  data: RealtimeEventMap[RealtimeEventType];
}

export interface SourceEvent {
  /** `module.type`. */
  name: string;
  payload: Record<string, unknown>;
}

const str = (value: unknown): string | undefined =>
  typeof value === 'string' && value !== '' ? value : undefined;
const num = (value: unknown): number => (typeof value === 'number' ? value : 0);

/** Events that change what the team screen shows: one `team.updated` signal for all of them. */
const TEAM_CHANGES = new Set([
  'teams.team_started',
  'teams.team_status_changed',
  'teams.team_updated',
  'teams.seat_opened',
  'teams.seat_closed',
  'teams.seat_desired_changed',
  'teams.lead_changed',
  'teams.offer_created',
  'teams.invitation_created',
  'teams.invitation_accepted',
  'teams.invitation_revoked',
]);

type Mapper = (p: Record<string, unknown>) => RealtimeSignal[];

function onTeam(
  teamId: string | undefined,
  type: RealtimeEventType,
  data: object,
): RealtimeSignal[] {
  if (teamId === undefined) return [];
  return [{ channel: `team:${teamId}`, type, data: data as RealtimeSignal['data'] }];
}

function onUser(
  userId: string | undefined,
  type: RealtimeEventType,
  data: object,
): RealtimeSignal[] {
  if (userId === undefined) return [];
  return [{ channel: `user:${userId}`, type, data: data as RealtimeSignal['data'] }];
}

const memberLeft: Mapper = (p) => {
  const [teamId, userId] = [str(p['teamId']), str(p['userId'])];
  return userId === undefined ? [] : onTeam(teamId, 'member.left', { teamId, userId });
};

const MAPPERS: Record<string, Mapper> = {
  'teams.member_joined': (p) => {
    const [teamId, userId] = [str(p['teamId']), str(p['userId'])];
    return userId === undefined ? [] : onTeam(teamId, 'member.joined', { teamId, userId });
  },
  'teams.member_left': memberLeft,
  'teams.member_excluded': memberLeft,
  'teams.vote_updated': (p) => {
    const [teamId, voteId, phase] = [str(p['teamId']), str(p['voteId']), str(p['status'])];
    if (!voteId || !phase) return [];
    const version = num(p['version'] ?? p['round']);
    return onTeam(teamId, 'vote.updated', { teamId, voteId, phase, version });
  },
  'workspace.notification_created': (p) => {
    const notificationId = str(p['notificationId']);
    if (notificationId === undefined) return [];
    return onUser(str(p['userId']), 'notification.created', { notificationId });
  },
  'workspace.item_updated': (p) => {
    const [teamId, itemId] = [str(p['teamId']), str(p['itemId'])];
    if (itemId === undefined) return [];
    return onTeam(teamId, 'item.updated', { teamId, itemId, version: num(p['version']) });
  },
  'workspace.project_completed': (p) =>
    onTeam(str(p['teamId']), 'project.completed', { teamId: str(p['teamId']) }),
  'profiles.resume_updated': (p) => {
    const [uploadId, status] = [str(p['uploadId']), str(p['status'])];
    if (!uploadId || !status) return [];
    return onUser(str(p['userId']), 'resume.updated', { uploadId, status });
  },
  'matching.application_changed': (p) => {
    const [applicationId, status] = [str(p['applicationId']), str(p['status'])];
    if (!applicationId || !status) return [];
    return onUser(str(p['userId']), 'application.changed', { applicationId, status });
  },
  'rewards.credits_changed': (p) =>
    onUser(str(p['userId']), 'credits.changed', { balanceVersion: num(p['balanceVersion']) }),
  'auth.session_revoked': (p) => onUser(str(p['userId']), 'session.revoked', {}),
  'auth.user_deletion_requested': (p) => onUser(str(p['userId']), 'session.revoked', {}),
};

/** Event names the relay subscribes to. */
export const REALTIME_SOURCES: readonly string[] = [...TEAM_CHANGES, ...Object.keys(MAPPERS)];

/** Maps an outbox event to the realtime signals it causes (architecture 9, 3.6). */
export function realtimeSignals(event: SourceEvent): RealtimeSignal[] {
  const p = event.payload;
  if (TEAM_CHANGES.has(event.name)) {
    const teamId = str(p['teamId']);
    return onTeam(teamId, 'team.updated', { teamId, version: num(p['version']) });
  }
  return MAPPERS[event.name]?.(p) ?? [];
}
