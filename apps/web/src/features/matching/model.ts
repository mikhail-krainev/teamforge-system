import { t } from '@/i18n';
import type { ApplicationRole, RoleDemand, SearchApplication } from './api';

/** Role codes of an application ordered by priority (1 = highest). */
export function orderedRoleCodes(application: SearchApplication): string[] {
  return [...application.roles].sort((a, b) => a.priority - b.priority).map((r) => r.roleCode);
}

/** Position in the list is the priority: 1..n without gaps (the contract needs unique values). */
export function toApplicationRoles(codes: readonly string[]): ApplicationRole[] {
  return codes.map((roleCode, index) => ({ roleCode, priority: index + 1 }));
}

const HOUR = 3600;
const DAY = 24 * HOUR;

/** "около 3 дн." / "около 5 ч" / "меньше часа"; `insufficient_data` has its own text. */
export function waitText(demand: Pick<RoleDemand, 'avgWaitSeconds' | 'avgWaitStatus'>): string {
  if (demand.avgWaitStatus === 'insufficient_data' || demand.avgWaitSeconds === null) {
    return t('matching.demand.waitUnknown');
  }
  const seconds = demand.avgWaitSeconds;
  if (seconds >= DAY) return t('matching.demand.waitDays', { n: Math.round(seconds / DAY) });
  if (seconds >= HOUR) return t('matching.demand.waitHours', { n: Math.round(seconds / HOUR) });
  return t('matching.demand.waitLess');
}
