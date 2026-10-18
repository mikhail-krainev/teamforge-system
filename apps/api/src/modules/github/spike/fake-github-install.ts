import { randomBytes } from 'node:crypto';

/**
 * S6-01 spike (temporary): minimal twin of the GitHub side of the App installation flow.
 * Modelled after docs.github.com: the install URL accepts `state`; with "Request user
 * authorization (OAuth) during installation" GitHub redirects to Callback URL #1 with
 * installation_id, setup_action, code and (assumed, see docs/research/github-state-spike.md) state.
 * Whether `state` really survives that chain is the item to verify by hand on a real App.
 */

export const REQUIRED_PERMISSIONS = ['metadata', 'issues', 'pull_requests', 'actions'] as const;

export interface GhUser {
  readonly id: number;
  readonly login: string;
}

export interface GhInstallation {
  readonly id: number;
  readonly accountLogin: string;
  readonly accountType: 'User' | 'Organization';
  readonly permissions: Readonly<Record<string, 'read' | 'write'>>;
  readonly installedBy: number;
}

export interface CallbackQuery {
  readonly installation_id?: string;
  readonly setup_action?: 'install' | 'update' | 'request';
  readonly state?: string;
  readonly code?: string;
}

export interface TwinOptions {
  /** Simulates GitHub not echoing `state` (the fallback case). */
  readonly dropState?: boolean;
  readonly permissions?: Readonly<Record<string, 'read' | 'write'>>;
}

export interface Account {
  readonly login: string;
  readonly type: 'User' | 'Organization';
  /** Users who are organization owners (for a User account: the user itself). */
  readonly ownerIds: readonly number[];
}

const ALL_READ = { metadata: 'read', issues: 'read', pull_requests: 'read', actions: 'read' } as const;

export class FakeGithubInstall {
  private nextInstallationId = 1000;
  private readonly installations = new Map<number, GhInstallation>();
  /** account login -> installation id (one App installation per account). */
  private readonly byAccount = new Map<string, number>();
  private readonly codes = new Map<string, { userId: number }>();
  private readonly tokens = new Map<string, number>();
  readonly webhooks: { event: string; installationId: number }[] = [];

  constructor(private readonly options: TwinOptions = {}) {}

  /** The user opens installations/new?state=... and finishes the dialog. Returns the redirect to Callback URL #1. */
  install(user: GhUser, account: Account, state: string): CallbackQuery {
    if (!account.ownerIds.includes(user.id)) {
      // Organization member without rights: GitHub asks the owner; the redirect carries no installation.
      return { setup_action: 'request', ...(this.options.dropState === true ? {} : { state }) };
    }
    const existing = this.byAccount.get(account.login);
    const id = existing ?? this.createInstallation(user, account);
    const code = randomBytes(8).toString('hex');
    this.codes.set(code, { userId: user.id });
    return {
      installation_id: String(id),
      setup_action: existing === undefined ? 'install' : 'update',
      code,
      ...(this.options.dropState === true ? {} : { state }),
    };
  }

  /** An owner approves a pending request later: installation appears, state is gone (different session). */
  approveRequest(owner: GhUser, account: Account): CallbackQuery {
    const id = this.byAccount.get(account.login) ?? this.createInstallation(owner, account);
    return { installation_id: String(id), setup_action: 'install' };
  }

  /** POST /login/oauth/access_token: the code is single use. */
  exchangeCode(code: string): string | null {
    const entry = this.codes.get(code);
    if (entry === undefined) return null;
    this.codes.delete(code);
    const token = `ghu_${randomBytes(8).toString('hex')}`;
    this.tokens.set(token, entry.userId);
    return token;
  }

  /** GET /user/installations: installations of accounts the user owns (simplified to ownership). */
  listUserInstallations(token: string, accounts: readonly Account[]): GhInstallation[] | null {
    const userId = this.tokens.get(token);
    if (userId === undefined) return null;
    return [...this.installations.values()].filter((installation) =>
      accounts.some((a) => a.login === installation.accountLogin && a.ownerIds.includes(userId)),
    );
  }

  /** The owner uninstalls the App. */
  deleteInstallation(id: number): void {
    const installation = this.installations.get(id);
    if (installation === undefined) return;
    this.installations.delete(id);
    this.byAccount.delete(installation.accountLogin);
    this.webhooks.push({ event: 'installation.deleted', installationId: id });
  }

  private createInstallation(by: GhUser, account: Account): number {
    const id = this.nextInstallationId++;
    this.installations.set(id, {
      id,
      accountLogin: account.login,
      accountType: account.type,
      permissions: this.options.permissions ?? ALL_READ,
      installedBy: by.id,
    });
    this.byAccount.set(account.login, id);
    return id;
  }
}
