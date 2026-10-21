import type { Member } from '@/features/teams/api';
import { t } from '@/i18n';
import type { ContributionSummary } from './api';

export type NameOf = (userId: string) => string;
export type RoleNameOf = (code: string) => string;

/** Display name of a participant; a user who is not in the roster any more is a deleted one (SEC-11). */
export function memberNameOf(members: readonly Pick<Member, 'userId' | 'displayName'>[]): NameOf {
  return (userId) =>
    members.find((member) => member.userId === userId)?.displayName ?? t('feed.entry.removedUser');
}

export interface RoleTotal {
  roleCode: string;
  issues: number;
  prs: number;
  artifacts: number;
  rituals: number;
  /** Participants who have a contribution in this role, in the order of the summary. */
  userIds: string[];
}

/** Contributions by role over the whole team (the results screen). */
export function totalsByRole(summary: ContributionSummary): RoleTotal[] {
  const totals = new Map<string, RoleTotal>();
  for (const member of summary.members) {
    for (const row of member.byRole) {
      const current = totals.get(row.roleCode) ?? {
        roleCode: row.roleCode,
        issues: 0,
        prs: 0,
        artifacts: 0,
        rituals: 0,
        userIds: [],
      };
      totals.set(row.roleCode, {
        ...current,
        issues: current.issues + row.issues,
        prs: current.prs + row.prs,
        artifacts: current.artifacts + row.artifacts,
        rituals: current.rituals + row.rituals,
        userIds: [...current.userIds, member.userId],
      });
    }
  }
  return [...totals.values()];
}
