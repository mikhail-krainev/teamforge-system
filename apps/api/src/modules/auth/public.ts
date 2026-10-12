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
}

/** Injection token of the AuthApi implementation. */
export const AUTH_API = Symbol('AUTH_API');
