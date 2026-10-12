/**
 * WebSocket message types (docs/architecture.md, section 9).
 * Hand-written: the WebSocket protocol is not described in OpenAPI.
 * Payloads carry only identifiers, versions and statuses (no personal data).
 */

export type UserChannel = `user:${string}`;
export type TeamChannel = `team:${string}`;
export type RealtimeChannel = UserChannel | TeamChannel;

/** Custom WebSocket close codes. */
export const WS_CLOSE_UNAUTHENTICATED = 4401;
export const WS_CLOSE_FORBIDDEN = 4403;

/** Server limits (architecture section 9), mirrored for client-side behaviour. */
export const WS_LIMITS = {
  pingIntervalMs: 25_000,
  idleTimeoutMs: 60_000,
  maxConnectionsPerUser: 5,
  maxSubscriptionsPerConnection: 50,
  maxClientMessagesPer10s: 20,
} as const;

/** Events delivered on `user:<userId>`. */
export interface UserEventMap {
  'notification.created': { notificationId: string };
  'resume.updated': { uploadId: string; status: string };
  'application.changed': { applicationId: string; status: string };
  'credits.changed': { balanceVersion: number };
  'session.revoked': { reason?: string };
}

/** Events delivered on `team:<teamId>`. */
export interface TeamEventMap {
  'team.updated': { teamId: string; version: number };
  'member.joined': { teamId: string; userId: string };
  'member.left': { teamId: string; userId: string };
  'vote.updated': { teamId: string; voteId: string; phase: string; version: number };
  'stage.opened': { teamId: string; stageId: string };
  'stage.closed': { teamId: string; stageId: string };
  'item.updated': { teamId: string; itemId: string; version: number };
  'contribution.recorded': { teamId: string; contributionId: string };
  'project.completed': { teamId: string };
}

export type UserEventType = keyof UserEventMap;
export type TeamEventType = keyof TeamEventMap;
export type RealtimeEventType = UserEventType | TeamEventType;

export interface RealtimeEventMap extends UserEventMap, TeamEventMap {}

/** Client -> server messages. */
export type ClientMessage =
  { op: 'subscribe'; channel: RealtimeChannel } | { op: 'unsubscribe'; channel: RealtimeChannel };

/** Server -> client event message; discriminated by `type`. */
export type ServerEventMessage = {
  [T in RealtimeEventType]: {
    op: 'event';
    channel: RealtimeChannel;
    type: T;
    data: RealtimeEventMap[T];
    /** ISO 8601 timestamp. */
    at: string;
  };
}[RealtimeEventType];

export interface ServerErrorMessage {
  op: 'error';
  code: string;
}

export type ServerMessage = ServerEventMessage | ServerErrorMessage;
