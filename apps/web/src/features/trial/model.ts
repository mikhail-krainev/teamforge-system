import type { Member } from '@/features/teams/api';

/** An auto-added member whose trial is still running (the server rejects the rest with 409). */
export function isOnTrial(
  member: Pick<Member, 'joinedVia' | 'trialUntil' | 'status'>,
  now: number = Date.now(),
): boolean {
  return (
    member.status === 'active' &&
    member.joinedVia === 'auto' &&
    member.trialUntil !== null &&
    new Date(member.trialUntil).getTime() > now
  );
}
