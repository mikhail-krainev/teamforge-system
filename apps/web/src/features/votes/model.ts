import { t } from '@/i18n';
import type { Team } from '@/features/teams/api';
import type { LeaderVote } from './api';

export const ACTIVE_STATUSES: readonly LeaderVote['status'][] = [
  'nominating',
  'voting',
  'runoff',
  'confirming',
  'offering',
];

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

export function isActive(vote: LeaderVote): boolean {
  return ACTIVE_STATUSES.includes(vote.status);
}

/** The vote on screen: the one in progress, otherwise the newest (the API lists newest first). */
export function pickVote(items: readonly LeaderVote[]): LeaderVote | undefined {
  return items.find(isActive) ?? items[0];
}

/** "2 д 3 ч", "5 ч 12 мин", "7 мин"; null when the deadline has passed. Minutes are enough: the text is read, not watched. */
export function formatRemaining(ms: number): string | null {
  if (ms <= 0) return null;
  const days = Math.floor(ms / DAY);
  const hours = Math.floor((ms % DAY) / HOUR);
  const minutes = Math.floor((ms % HOUR) / MINUTE);
  if (days > 0) return t('votes.time.daysHours', { days, hours });
  if (hours > 0) return t('votes.time.hoursMinutes', { hours, minutes });
  return t('votes.time.minutes', { minutes: Math.max(1, minutes) });
}

/** A candidate takes part in the ballot once confirmed and while not withdrawn. */
export function isVotable(candidate: LeaderVote['candidates'][number]): boolean {
  return candidate.confirmed && !candidate.withdrawn;
}

/**
 * The lead of record whose inactivity opened the vote can still call it off, until the first ballot
 * (the server decides; this only decides whether to offer the button).
 */
export function canReturnAsLead(
  vote: LeaderVote,
  team: Pick<Team, 'leadUserId'>,
  meId: string,
): boolean {
  return (
    vote.trigger === 'lead_inactive' &&
    isActive(vote) &&
    vote.ballotsCast === 0 &&
    team.leadUserId === meId
  );
}
