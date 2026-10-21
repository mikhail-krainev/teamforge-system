import type { CompletionSnapshot } from '../../../workspace/public.js';
import { BADGE, SERIES_STEPS, STREAK_LENGTH } from './constants.js';

/** What the individual badges of a person are computed from (architecture 10.3), read after his credit rows are in. */
export interface UserStats {
  /** `count(DISTINCT roster_hash)` of the credited projects: identical teams count once (AF-13). */
  distinctRosters: number;
  /** Distinct roles with a credited `credit` row. */
  roles: number;
  /** Distinct product types of the credited projects. */
  productTypes: number;
  /** `overdue_days` of the last credited projects, newest first, at most three. */
  lastOverdue: number[];
}

export interface ProjectFacts {
  /** `overdue_days` of the project that is credited now. */
  overdueDays: number;
  /** The person holds a credited role with `deficit_at_join` in this project. */
  closedDeficit: boolean;
}

function reached(series: keyof typeof SERIES_STEPS, count: number): string[] {
  return SERIES_STEPS[series].filter((step) => count >= step.at).map((step) => step.code);
}

/** All the badges the person has earned by now; the ones he holds already are filtered out by the insert. */
export function individualBadges(stats: UserStats, project: ProjectFacts): string[] {
  const codes: string[] = [
    ...reached('projects', stats.distinctRosters),
    ...reached('roles', stats.roles),
    ...reached('product_types', stats.productTypes),
  ];
  if (project.overdueDays === 0) codes.push(BADGE.onTime);
  const lastThree = stats.lastOverdue.slice(0, STREAK_LENGTH);
  if (lastThree.length === STREAK_LENGTH && lastThree.every((days) => days === 0)) {
    codes.push(BADGE.streak);
  }
  if (project.closedDeficit) codes.push(BADGE.deficit);
  return codes;
}

export interface CreditedRole {
  userId: string;
  roleCode: string;
  deficitAtJoin: boolean;
}

/**
 * FR-REW-10: a seat marked "желательная" at the completion is held by a person with a credited credit of the
 * seat's role and `deficit_at_join`. Then every person active at the completion gets the team badge, whatever
 * his own credit is (a person who left early is not in the snapshot roster).
 */
export function teamBonusRecipients(
  snapshot: CompletionSnapshot,
  credited: readonly CreditedRole[],
): string[] {
  const closed = snapshot.roster.seats.some(
    (seat) =>
      seat.desired &&
      seat.holderUserId !== null &&
      credited.some(
        (c) => c.userId === seat.holderUserId && c.roleCode === seat.roleCode && c.deficitAtJoin,
      ),
  );
  return closed ? snapshot.roster.members.map((m) => m.userId) : [];
}
