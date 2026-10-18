import { randomBytes } from 'node:crypto';
import type { Account, CallbackQuery, FakeGithubInstall } from './fake-github-install.js';
import { REQUIRED_PERMISSIONS } from './fake-github-install.js';

/**
 * S6-01 spike (temporary): the platform side of the installation `state` flow from
 * architecture 7.2. Redis is replaced by an in-memory map with the same GETDEL semantics.
 */

export const STATE_TTL_MS = 600_000;

export type CallbackResult =
  | { readonly ok: true; readonly teamId: string | null; readonly installationId: number; readonly mode: 'state' | 'fallback' }
  | { readonly ok: false; readonly error: StateError };

export type StateError =
  | 'STATE_INVALID'
  | 'STATE_USER_MISMATCH'
  | 'NOT_LEAD'
  | 'CODE_MISSING'
  | 'CODE_REJECTED'
  | 'INSTALLATION_NOT_OWNED'
  | 'PERMISSIONS_MISSING'
  | 'PENDING_APPROVAL';

export interface Grant {
  readonly installationId: number;
  readonly teamId: string | null;
  readonly userId: number;
  revokedAt: number | null;
}

export interface FlowDeps {
  readonly github: FakeGithubInstall;
  readonly accounts: readonly Account[];
  readonly now: () => number;
  readonly isLead: (teamId: string, userId: number) => boolean;
}

export class InstallStateFlow {
  private readonly store = new Map<string, { value: { teamId: string; userId: number }; expiresAt: number }>();
  readonly grants: Grant[] = [];
  storeReads = 0;

  constructor(private readonly deps: FlowDeps) {}

  /** createInstallationSession: random state, 32 bytes base64url, TTL 600 s. */
  createSession(teamId: string, userId: number): string {
    const state = randomBytes(32).toString('base64url');
    this.store.set(state, { value: { teamId, userId }, expiresAt: this.deps.now() + STATE_TTL_MS });
    return state;
  }

  /** GETDEL: synchronous read-and-delete, so one of N concurrent callers wins (Redis GETDEL is atomic). */
  private getDel(state: string): { teamId: string; userId: number } | null {
    this.storeReads += 1;
    const entry = this.store.get(state);
    if (entry === undefined) return null;
    this.store.delete(state);
    return entry.expiresAt > this.deps.now() ? entry.value : null;
  }

  /** githubSetupCallback. `sessionUserId` is the platform user of the browser session. */
  async callback(sessionUserId: number, query: CallbackQuery): Promise<CallbackResult> {
    if (query.installation_id === undefined) return { ok: false, error: 'PENDING_APPROVAL' };
    const installationId = Number(query.installation_id);
    if (query.code === undefined) return { ok: false, error: 'CODE_MISSING' };

    let teamId: string | null = null;
    let mode: 'state' | 'fallback' = 'fallback';
    if (query.state !== undefined) {
      // A state with ':' could name a cache key in the shared gh_state: namespace.
      if (query.state.includes(':')) return { ok: false, error: 'STATE_INVALID' };
      const session = this.getDel(query.state);
      if (session === null) return { ok: false, error: 'STATE_INVALID' };
      if (session.userId !== sessionUserId) return { ok: false, error: 'STATE_USER_MISMATCH' };
      if (!this.deps.isLead(session.teamId, sessionUserId)) return { ok: false, error: 'NOT_LEAD' };
      teamId = session.teamId;
      mode = 'state';
    }

    const token = this.deps.github.exchangeCode(query.code);
    if (token === null) return { ok: false, error: 'CODE_REJECTED' };
    const owned = this.deps.github.listUserInstallations(token, this.deps.accounts) ?? [];
    const installation = owned.find((i) => i.id === installationId);
    if (installation === undefined) return { ok: false, error: 'INSTALLATION_NOT_OWNED' };
    if (REQUIRED_PERMISSIONS.some((p) => installation.permissions[p] !== 'read' && installation.permissions[p] !== 'write')) {
      return { ok: false, error: 'PERMISSIONS_MISSING' };
    }
    this.addGrant({ installationId, teamId, userId: sessionUserId, revokedAt: null });
    return { ok: true, teamId, installationId, mode };
  }

  /** Webhook installation.deleted: revoke every grant of the installation. */
  onInstallationDeleted(installationId: number): void {
    for (const grant of this.grants) {
      if (grant.installationId === installationId && grant.revokedAt === null) grant.revokedAt = this.deps.now();
    }
  }

  activeGrants(installationId: number): Grant[] {
    return this.grants.filter((g) => g.installationId === installationId && g.revokedAt === null);
  }

  /** installation_grant is unique per (installation, team, user): a repeat is a no-op. */
  private addGrant(grant: Grant): void {
    const duplicate = this.grants.some(
      (g) =>
        g.revokedAt === null &&
        g.installationId === grant.installationId &&
        g.teamId === grant.teamId &&
        g.userId === grant.userId,
    );
    if (!duplicate) this.grants.push(grant);
  }
}
