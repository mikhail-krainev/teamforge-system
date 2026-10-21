import type { Page } from '../../platform/db/pagination.js';

/**
 * Public surface of the profiles module (ADR-0001): the only file other modules may import.
 */
export const PROFILES_MODULE = 'profiles' as const;

export type UserId = string;
export type RoleCode = string;
export type Level = 'beginner' | 'junior' | 'middle';

export interface PageQuery {
  cursor?: string | undefined;
  limit?: number | undefined;
}

/** What matching and teams read about a person (architecture 3.2). */
export interface MatchingProfile {
  userId: UserId;
  timezone: string;
  hoursPerWeek: number;
  stack: string[];
  /** In priority order. */
  rolePrefs: { roleCode: RoleCode; level: Level }[];
}

/** Name shown where a user has no profile any more (FR-AUTH-09). */
export const DELETED_USER_NAME = 'Удалённый пользователь';

/** Facade of the profiles module for teams and matching (read-only). */
export interface ProfilesApi {
  /**
   * Batch read, no N+1; users without a profile are absent from the result, and so are accounts
   * that are not `active` or have no valid consent (SEC-11) unless `includeIneligible`: that is for
   * a caller that checks eligibility itself under lock #1 and shows the profile to nobody.
   */
  getMatchingProfiles(
    userIds: UserId[],
    options?: { includeIneligible?: boolean },
  ): Promise<MatchingProfile[]>;
  /**
   * Profiles that prefer `role`, keyset-paged by user id. Only people who may be matched: the
   * account is `active` and the consent is valid (SEC-11).
   */
  listMatchingProfilesByRole(role: RoleCode, query: PageQuery): Promise<Page<MatchingProfile>>;
  /** A name for every requested id; ids without a profile map to `DELETED_USER_NAME`. */
  getDisplayNames(userIds: UserId[]): Promise<Map<UserId, string>>;
  listRoles(options?: {
    includeInactive?: boolean;
  }): Promise<{ code: RoleCode; name: string; active: boolean }[]>;
  /** Throws 422 VALIDATION_FAILED listing the unknown codes. */
  assertRolesExist(codes: RoleCode[], options?: { activeOnly?: boolean }): Promise<void>;
  assertStackTagsExist(codes: string[]): Promise<void>;
}

/** Injection token of the ProfilesApi implementation. */
export const PROFILES_API = Symbol('PROFILES_API');

/** Outbox event of the publication of a batch of reviews: one per subject, `{ teamId, teamName, userId }` (no author data). */
export const REVIEWS_PUBLISHED = 'reviews_published' as const;

/** A completed project as the review window needs it (FR-PROF-08, C-27). */
export interface CompletedProject {
  teamId: string;
  teamName: string;
  completedAt: Date;
  /** The participants of the record of the completion. */
  memberUserIds: string[];
}

/**
 * Port of the safety-net scanner `review-eligibility-scan`: profiles may not import workspace (architecture
 * 2.2), so workspace implements it and binds `COMPLETED_PROJECTS_PORT`. Completions dated `since` or later,
 * oldest first, keyset by `(completedAt, teamId)`; `after` is the last row of the previous page.
 */
export interface CompletedProjectsPort {
  listCompletedSince(
    since: Date,
    page: { limit: number; after?: { completedAt: Date; teamId: string } },
  ): Promise<CompletedProject[]>;
}

export const COMPLETED_PROJECTS_PORT = Symbol('COMPLETED_PROJECTS_PORT');
