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
  /** Batch read, no N+1; users without a profile are absent from the result. */
  getMatchingProfiles(userIds: UserId[]): Promise<MatchingProfile[]>;
  /** Profiles that prefer `role`, keyset-paged by user id. */
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
