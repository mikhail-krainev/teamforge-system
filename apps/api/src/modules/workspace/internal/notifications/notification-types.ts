/**
 * In-app notification types (FR-WORK-19). The web client maps them to ru texts
 * (`apps/web/src/i18n/ru/notifications.json`); an unknown type falls back to a generic text.
 */
export const NOTIFICATION_TYPES = [
  'seat_offer',
  'join_request',
  'invitation_accepted',
  'member_joined',
  'member_left',
  'seat_opened',
  'lead_changed',
  'team_started',
  'vote_opened',
  'vote_closed',
  'leader_offer',
  'auto_added',
  'stage_due',
  'repo_unlinked',
  'reviews_published',
] as const;
export type NotificationType = (typeof NOTIFICATION_TYPES)[number];

/** Types that also go out by e-mail: the user must act or does not see the screen (13.13). */
export const MAILED_TYPES: ReadonlySet<NotificationType> = new Set([
  'seat_offer',
  'vote_opened',
  'leader_offer',
  'auto_added',
]);

/** A notification to create; the payload carries identifiers and codes only (SEC-11). */
export interface NotificationDraft {
  userId: string;
  type: NotificationType;
  payload: Record<string, string | number | boolean | null>;
  /** Unique per user: a repeated delivery of the same event creates nothing new. */
  dedupeKey: string;
}
