import type { QueryKey } from '@tanstack/react-query';
import { ME_QUERY_KEY } from '@/features/auth/session';
import { RESUME_KEY } from '@/features/profile/resume/api';
import { teamEventsKey, teamKey } from '@/features/teams/api';
import { departuresKey } from '@/features/offers/api';
import type { RealtimeSignal } from '@/lib/realtime';
import { NOTIFICATIONS_ROOT } from './api';
import { votesKey } from '@/features/votes/api';

/** The id after `team:` / `user:` - taken from the channel we subscribed to, never from a payload. */
function channelId(channel: string): string {
  return channel.slice(channel.indexOf(':') + 1);
}

/**
 * Which cached queries an event makes stale. Events carry no data, so the answer depends on the
 * event type and the channel only; the refetch goes through REST with the normal rights check.
 */
export function keysFor({ type, channel }: RealtimeSignal): readonly QueryKey[] {
  const id = channelId(channel);
  switch (type) {
    case 'notification.created':
      return [NOTIFICATIONS_ROOT];
    case 'resume.updated':
      return [RESUME_KEY];
    case 'session.revoked':
      return [ME_QUERY_KEY];
    case 'application.changed':
      return [['applications']];
    case 'credits.changed':
      return [['credits']];
    case 'team.updated':
    case 'member.joined':
    case 'member.left':
      return [
        teamKey(id),
        teamEventsKey(id),
        departuresKey(id),
        ['teams', 'list'],
        ['offers'],
        votesKey(id),
      ];
    case 'vote.updated':
      return [votesKey(id), teamKey(id), teamEventsKey(id)];
    case 'project.completed':
      return [teamKey(id), teamEventsKey(id)];
    default:
      // stage.*, item.*, contribution.*: no screens in this slice yet; refresh the team only.
      return channel.startsWith('team:') ? [teamKey(id)] : [];
  }
}
