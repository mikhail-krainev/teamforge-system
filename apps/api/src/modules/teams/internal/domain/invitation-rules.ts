import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

const DAY_MS = 24 * 60 * 60 * 1000;

/** C-12: lifetime of an invitation. */
export const INVITATION_TTL_MS = 7 * DAY_MS;
/** C-13: active invitations per team, counted under the team lock. */
export const MAX_ACTIVE_INVITATIONS = 20;
/** Used, revoked and expired invitations are deleted after this long (maintenance). */
export const INVITATION_RETENTION_MS = 30 * DAY_MS;

/** 32 random bytes as base64url: 43 characters, shown once to the lead. */
export function newInvitationToken(): string {
  return randomBytes(32).toString('base64url');
}

/** Only this hash is stored (SEC-18); the token itself cannot be read back. */
export function hashInvitationToken(token: string): Buffer {
  return createHash('sha256').update(token).digest();
}

export interface InvitationAddress {
  inviteeGithubUserId: number | null;
  inviteeEmailHmac: Buffer | null;
}

/** What is known about the person who holds the token. */
export interface Holder {
  githubUserId: number | null;
  emailHmac: Buffer | null;
}

/** A link invitation is open to everyone; an addressed one only to the matching account (FR-TEAM-09). */
export function isAddressee(address: InvitationAddress, holder: Holder): boolean {
  if (address.inviteeGithubUserId !== null) {
    return holder.githubUserId === address.inviteeGithubUserId;
  }
  if (address.inviteeEmailHmac !== null) {
    const mine = holder.emailHmac;
    return (
      mine !== null &&
      mine.length === address.inviteeEmailHmac.length &&
      timingSafeEqual(mine, address.inviteeEmailHmac)
    );
  }
  return true;
}

export interface InvitationState {
  status: string;
  expiresAt: Date;
}

/** An invitation is usable while it is `active` and not past its term (a late row is not yet swept). */
export function isUsable(state: InvitationState, now: Date): boolean {
  return state.status === 'active' && state.expiresAt > now;
}

/** `active` past its term reads as `expired` before the sweeper rewrites the row. */
export function shownStatus(state: InvitationState, now: Date): string {
  return state.status === 'active' && state.expiresAt <= now ? 'expired' : state.status;
}

/** `inviteeHint` of the contract: the GitHub login, the word "email", or nothing for a link. */
export function inviteeHint(row: {
  inviteeGithubLogin: string | null;
  inviteeEmailHmac: Buffer | null;
}): string | null {
  if (row.inviteeGithubLogin !== null) return row.inviteeGithubLogin;
  return row.inviteeEmailHmac === null ? null : 'email';
}
