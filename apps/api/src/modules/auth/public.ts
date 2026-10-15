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
  /**
   * SEC-18: HMAC-SHA-256 (key `IP_HASH_SALT`) of the normalized e-mail, as raw bytes. Lets a module
   * address a person by e-mail without keeping the address (teams: invitations).
   */
  hmacOfEmail(email: string): Buffer;
  /** The same HMAC for the address of an account; `null` when the account has no address. */
  getEmailHmac(userId: UserId): Promise<Buffer | null>;
  /**
   * SEC-11: the e-mail address for a transactional mail, read at send time. `null` when the
   * account is not `active`, has no address or has no valid consent (no mail is sent then).
   */
  getMailRecipient(userId: UserId): Promise<string | null>;
  findUserIdsByGithubIds(githubUserIds: number[]): Promise<Map<number, UserId>>;
  isAdmin(userId: UserId): Promise<boolean>;
  hasValidConsent(userId: UserId): Promise<boolean>;
  /**
   * Which of the users may be shown to others in matching (SEC-11): the account is `active` and the
   * consent of the current text is valid. One batch, no per-user queries.
   */
  filterMatchable(userIds: UserId[]): Promise<Set<UserId>>;
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
