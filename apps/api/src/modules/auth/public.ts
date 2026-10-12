/**
 * Public surface of the auth module (ADR-0001): the only file other modules may import.
 */
export const AUTH_MODULE = 'auth' as const;

export type UserId = string;

export interface JoinEligibility {
  userId: UserId;
  status: 'active' | 'deleting' | 'deleted';
  githubUserId: number | null;
  consentValid: boolean;
}

export interface UserIdentity {
  githubUserId: number | null;
  githubLogin: string | null;
  status: string;
}

export interface IdentitySignal {
  userId: UserId;
  kind: 'ip24' | 'ua' | 'device';
  /** Hex of the HMAC-SHA-256; raw values are never stored (SEC-13). */
  valueHmac: string;
}

/**
 * Facade of the auth module (architecture 3.1). `reportDeletionStep` and `matchesTombstone` join
 * it with the deletion saga (S2-07).
 */
/** Modules that take part in the deletion saga (architecture 13.9); each joins in its own slice. */
export type DeletionModule = 'profiles' | 'teams' | 'matching' | 'workspace' | 'github' | 'rewards';

export interface AuthApi {
  /**
   * Lock #1 of the global order (`auth.user ... FOR NO KEY UPDATE`); must run inside a transaction.
   * Throws USER_INACTIVE (409) when the account is not `active`.
   */
  lockUserForJoin(userId: UserId): Promise<JoinEligibility>;
  getIdentity(userId: UserId): Promise<UserIdentity | null>;
  findUserIdsByGithubIds(githubUserIds: number[]): Promise<Map<number, UserId>>;
  isAdmin(userId: UserId): Promise<boolean>;
  hasValidConsent(userId: UserId): Promise<boolean>;
  getIdentitySignals(userIds: UserId[], since: Date): Promise<IdentitySignal[]>;
  /**
   * Called by a module when its step of the deletion saga is done (idempotent, joins the caller's
   * transaction). The last expected module triggers the final step of auth.
   */
  reportDeletionStep(
    requestId: string,
    module: DeletionModule,
    counts: Record<string, number>,
  ): Promise<void>;
  /** SEC-13: true when the github_user_id or e-mail of the user matches a tombstone of a deleted account (AF-15). */
  matchesTombstone(userId: UserId): Promise<boolean>;
}

/** Outbox event that starts the saga in every module: `{ requestId, userId, reason }`. */
export const USER_DELETION_REQUESTED = 'auth.user_deletion_requested' as const;

/** Injection token of the AuthApi implementation. */
export const AUTH_API = Symbol('AUTH_API');
