import { createPublicKey, type KeyObject } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { GithubAppHttp } from './github-app-http.js';
import {
  ALL_READ,
  DEFAULT_QUOTA,
  iso,
  processKey,
  type AppClock,
  type GithubAppOptions,
  type IdentityLike,
  type InstallOptions,
  type InstallResult,
  type ItemSpec,
  type Permissions,
  type RepoSpec,
  type ThrottleOptions,
  type TokenRecord,
  type TwinAccount,
  type TwinCall,
  type TwinContributor,
  type TwinInstallation,
  type TwinItem,
  type TwinRepo,
  type WorkflowRun,
} from './github-app-types.js';
import {
  buildWebhook,
  installationPayload,
  installationRepositoriesPayload,
  issuesPayload,
  pullRequestPayload,
  repositoryEventPayload,
  repositoryPayload,
  reviewPayload,
  type SignatureMode,
  type TwinPerson,
  type WebhookRequest,
  type WebhookSink,
} from './github-webhooks.js';

export * from './github-app-types.js';

/**
 * Double of the GitHub App side of GitHub (docs/plan.md S6-02; architecture 7.1-7.5; the installation
 * flow is the one confirmed by the S6-01 prototype, docs/research/github-state-spike.md). It lives in
 * the process of the test and is mounted on the same HTTP server as the sign-in double
 * (`test/fakes/github-server.ts`, `GithubServer.app`). It models:
 *  - the App JWT (RS256, `iss` = App id, at most 10 minutes) required by `/app/*`; a bad JWT is a 401;
 *  - `POST /app/installations/{id}/access_tokens` (`ghs_` tokens, one hour, by the controllable clock);
 *  - `GET /user/installations` for user-to-server tokens, installations with their permissions;
 *  - repositories, issues, pull requests, reviews, contributors, workflow runs, account lookups;
 *  - ETag / `If-None-Match` (a 304 costs no quota), the hourly quota, secondary limits with `Retry-After`;
 *  - webhooks with a correct or a wrong `X-Hub-Signature-256` (see `github-webhooks.ts`).
 * Everything GitHub would answer is derived from the state below; tests change the state with the
 * methods of the class and read what the application asked for in `calls`.
 */

export class GithubAppTwin {
  readonly appId: number;
  readonly slug: string;
  readonly webhookSecret: string;
  readonly privateKeyPem: string;
  /** Callback URL #1 of the App (`${APP_ORIGIN}/api/v1/github/setup`); the browser route redirects there. */
  callbackUrl: string | undefined;
  /** Every request the application sent to the App endpoints, in order. */
  readonly calls: TwinCall[] = [];
  /** Webhooks delivered through `deliver`, in order. */
  readonly deliveries: {
    event: string;
    deliveryId: string;
    status: number;
    signature: SignatureMode;
  }[] = [];

  readonly publicKey: KeyObject;
  readonly clock: AppClock;
  readonly installations = new Map<number, TwinInstallation>();
  readonly byAccount = new Map<number, number>();
  readonly repos = new Map<number, TwinRepo>();
  readonly items = new Map<number, TwinItem[]>();
  readonly runs = new Map<number, WorkflowRun[]>();
  readonly accounts = new Map<number, TwinAccount>();
  /** GitHub user id -> installations visible to that user in `GET /user/installations`. */
  readonly userAccess = new Map<number, Set<number>>();
  readonly tokens = new Map<string, TokenRecord>();
  readonly tokenCount = new Map<number, number>();
  readonly browserInstalls: {
    by: IdentityLike;
    account: TwinAccount;
    options: Partial<InstallOptions>;
  }[] = [];
  nextInstallationId = 70_000_000;
  nextRepoId = 810_000_000;
  nextRunId = 9_000_000;
  quotaRemaining = DEFAULT_QUOTA;
  quotaResetAt = 0;
  blockedUntil = 0;
  blockedStatus: 403 | 429 = 403;
  forcedFailures: { status: number; body?: unknown; retryAfter?: number; matcher?: RegExp }[] = [];

  constructor(readonly options: GithubAppOptions) {
    this.appId = options.appId ?? 424242;
    this.slug = options.slug ?? 'teamforge-test';
    this.webhookSecret = options.webhookSecret ?? 'test-github-webhook-secret-0001';
    const key = processKey();
    this.privateKeyPem = options.privateKeyPem ?? key.privateKeyPem;
    this.publicKey = options.privateKeyPem ? createPublicKey(options.privateKeyPem) : key.publicKey;
    this.clock = options.clock ?? { now: () => new Date() };
  }

  // ---- state: installations, repositories, items -----------------------------------------------

  /** Registers an account GitHub knows (`GET /user/{id}`, FR-GH-09). */
  addAccount(account: TwinAccount): TwinAccount {
    this.accounts.set(account.id, account);
    return account;
  }

  /** The installation of the account (one per account); created with `repos` when it is new. */
  installApp(account: TwinAccount, options: Partial<InstallOptions> = {}): TwinInstallation {
    this.addAccount(account);
    const existingId = this.byAccount.get(account.id);
    const existing = existingId === undefined ? undefined : this.installations.get(existingId);
    if (existing && !existing.deleted) return existing;
    const installation: TwinInstallation = {
      id: this.nextInstallationId++,
      account,
      permissions: options.permissions ?? ALL_READ,
      repositorySelection: options.repositorySelection ?? 'selected',
      suspendedAt: null,
      deleted: false,
    };
    this.installations.set(installation.id, installation);
    this.byAccount.set(account.id, installation.id);
    for (const owner of account.ownerIds ?? [account.id])
      this.grantUserAccess(owner, installation.id);
    for (const spec of options.repos ?? []) this.addRepo(installation.id, spec);
    return installation;
  }

  installation(id: number): TwinInstallation {
    const found = this.installations.get(id);
    if (!found) throw new Error(`the double has no installation ${id}`);
    return found;
  }

  /** `GET /user/installations` of this GitHub user lists the installation. */
  grantUserAccess(githubUserId: number, installationId: number): void {
    const set = this.userAccess.get(githubUserId) ?? new Set<number>();
    set.add(installationId);
    this.userAccess.set(githubUserId, set);
  }

  setPermissions(installationId: number, permissions: Permissions): void {
    this.installation(installationId).permissions = permissions;
  }

  suspend(installationId: number): void {
    this.installation(installationId).suspendedAt = iso(this.clock.now());
  }

  /** The owner uninstalls the App: tokens stop working, `GET /app/installations/{id}` is 404. */
  uninstall(installationId: number): void {
    const installation = this.installation(installationId);
    installation.deleted = true;
    this.byAccount.delete(installation.account.id);
    for (const [token, record] of this.tokens) {
      if (record.installationId === installationId) this.tokens.delete(token);
    }
  }

  addRepo(installationId: number, spec: RepoSpec): TwinRepo {
    const installation = this.installation(installationId);
    const repo: TwinRepo = {
      id: this.nextRepoId++,
      fullName: `${installation.account.login}/${spec.name}`,
      private: spec.private ?? false,
      fork: spec.fork ?? false,
      archived: spec.archived ?? false,
      createdAt: spec.createdAt ?? iso(this.clock.now()),
      ownerId: installation.account.id,
      ownerLogin: installation.account.login,
      installationId,
      defaultBranch: 'main',
      contributors: spec.contributors ?? [],
      gone: false,
    };
    this.repos.set(repo.id, repo);
    this.items.set(repo.id, []);
    this.runs.set(repo.id, []);
    return repo;
  }

  repo(id: number): TwinRepo {
    const found = this.repos.get(id);
    if (!found) throw new Error(`the double has no repository ${id}`);
    return found;
  }

  setContributors(repoId: number, contributors: TwinContributor[]): void {
    this.repo(repoId).contributors = contributors;
  }

  archive(repoId: number): void {
    this.repo(repoId).archived = true;
  }

  makePrivate(repoId: number): void {
    this.repo(repoId).private = true;
  }

  rename(repoId: number, name: string): void {
    const repo = this.repo(repoId);
    repo.fullName = `${repo.ownerLogin}/${name}`;
  }

  /** The repository leaves the installation (or is deleted): the installation token no longer reaches it. */
  removeRepo(repoId: number): void {
    this.repo(repoId).gone = true;
  }

  setWorkflowRuns(repoId: number, runs: Omit<WorkflowRun, 'id'>[]): void {
    this.runs.set(
      repoId,
      runs.map((run) => ({ ...run, id: this.nextRunId++ })),
    );
  }

  private nextNumber(repoId: number): number {
    return (this.items.get(repoId) ?? []).length + 1;
  }

  private touchTime(previous: string | undefined, at?: Date): string {
    const now = at ?? this.clock.now();
    if (at || previous === undefined) return iso(now);
    // GitHub stamps whole seconds: an update is strictly later than the previous stamp.
    const floor = new Date(Date.parse(previous) + 1000);
    return iso(now > floor ? now : floor);
  }

  private open(repoId: number, kind: 'issue' | 'pr', spec: ItemSpec): TwinItem {
    const when = iso(spec.at ?? this.clock.now());
    const item: TwinItem = {
      repoId,
      gone: false,
      number: this.nextNumber(repoId),
      kind,
      title: spec.title ?? `${kind === 'pr' ? 'Pull request' : 'Issue'} ${this.nextNumber(repoId)}`,
      state: 'open',
      merged: false,
      author: spec.author,
      assignees: spec.assignees ?? [],
      labels: spec.labels ?? [],
      body: spec.body ?? '',
      additions: spec.additions ?? 40,
      deletions: spec.deletions ?? 10,
      createdAt: when,
      updatedAt: when,
      closedAt: null,
      mergedAt: null,
      reviews: [],
    };
    this.items.get(repoId)?.push(item);
    return item;
  }

  openIssue(repoId: number, spec: ItemSpec): TwinItem {
    return this.open(repoId, 'issue', spec);
  }

  openPull(repoId: number, spec: ItemSpec): TwinItem {
    return this.open(repoId, 'pr', spec);
  }

  item(repoId: number, number: number): TwinItem {
    const found = (this.items.get(repoId) ?? []).find((i) => i.number === number);
    if (!found) throw new Error(`the double has no item #${number} in repository ${repoId}`);
    return found;
  }

  closeIssue(repoId: number, number: number, at?: Date): TwinItem {
    const item = this.item(repoId, number);
    item.state = 'closed';
    item.updatedAt = this.touchTime(item.updatedAt, at);
    item.closedAt = item.updatedAt;
    return item;
  }

  reopenIssue(repoId: number, number: number, at?: Date): TwinItem {
    const item = this.item(repoId, number);
    item.state = 'open';
    item.closedAt = null;
    item.updatedAt = this.touchTime(item.updatedAt, at);
    return item;
  }

  mergePull(repoId: number, number: number, at?: Date): TwinItem {
    const item = this.item(repoId, number);
    item.state = 'closed';
    item.merged = true;
    item.updatedAt = this.touchTime(item.updatedAt, at);
    item.closedAt = item.updatedAt;
    item.mergedAt = item.updatedAt;
    return item;
  }

  closePullUnmerged(repoId: number, number: number, at?: Date): TwinItem {
    const item = this.item(repoId, number);
    item.state = 'closed';
    item.updatedAt = this.touchTime(item.updatedAt, at);
    item.closedAt = item.updatedAt;
    return item;
  }

  review(
    repoId: number,
    number: number,
    reviewer: TwinPerson,
    state: 'approved' | 'changes_requested' | 'commented' = 'approved',
  ): TwinItem {
    const item = this.item(repoId, number);
    item.reviews.push({ reviewer, state, submittedAt: iso(this.clock.now()) });
    return item;
  }

  /** The issue is deleted on GitHub: it vanishes from lists and direct reads. */
  deleteItem(repoId: number, number: number): TwinItem {
    const item = this.item(repoId, number);
    item.gone = true;
    return item;
  }

  // ---- rate limits and failures ----------------------------------------------------------------

  /** Until the clock passes `now + retryAfterSeconds` every REST call answers with `Retry-After`. */
  throttle(options: ThrottleOptions): void {
    this.blockedUntil = this.clock.now().getTime() + options.retryAfterSeconds * 1000;
    this.blockedStatus = options.status ?? 403;
  }

  /** The hourly quota is used up until `resetsInSeconds` pass (primary limit: 403 + `x-ratelimit-remaining: 0`). */
  exhaustQuota(resetsInSeconds = 3600): void {
    this.quotaRemaining = 0;
    this.quotaResetAt = this.clock.now().getTime() + resetsInSeconds * 1000;
  }

  /** The next request (optionally only those whose path matches) answers with this status once. */
  failNext(
    status: number,
    options: { retryAfter?: number; body?: unknown; matcher?: RegExp } = {},
  ): void {
    this.forcedFailures.push({ status, ...options });
  }

  get quota(): { remaining: number; limit: number } {
    return { remaining: this.quotaRemaining, limit: DEFAULT_QUOTA };
  }

  /** Calls whose path matches, e.g. `callsTo(/\/issues$/)`. */
  callsTo(pattern: RegExp): TwinCall[] {
    return this.calls.filter((call) => pattern.test(call.path));
  }

  tokensIssued(installationId: number): number {
    return this.tokenCount.get(installationId) ?? 0;
  }

  // ---- the installation dialog -----------------------------------------------------------------

  /**
   * The user finishes the installation dialog (`installations/new?state=...`). Returns the query of the
   * redirect to Callback URL #1, like the S6-01 twin: `installation_id`, `setup_action`, `code`, `state`.
   * An organization member who may not install gets `setup_action=request` without an installation.
   */
  install(by: IdentityLike, account: TwinAccount, options: InstallOptions): InstallResult {
    const owners = account.ownerIds ?? [account.id];
    const state: Record<string, string> = options.dropState ? {} : { state: options.state };
    if (!owners.includes(by.id)) {
      return { query: { setup_action: 'request', ...state }, installation: undefined };
    }
    const existing = this.byAccount.get(account.id);
    const known = existing === undefined ? undefined : this.installations.get(existing);
    const installation = known && !known.deleted ? known : this.installApp(account, options);
    this.grantUserAccess(by.id, installation.id);
    const code = this.options.issueCode(by, this.callbackUrl ?? '');
    return {
      query: {
        installation_id: String(installation.id),
        setup_action: known && !known.deleted ? 'update' : 'install',
        code,
        ...state,
      },
      installation,
    };
  }

  /** The owner approves a pending request later: an installation appears, with neither `state` nor `code`. */
  approveRequest(owner: IdentityLike, account: TwinAccount): InstallResult {
    const installation = this.installApp({ ...account, ownerIds: [owner.id] });
    return {
      query: { installation_id: String(installation.id), setup_action: 'install' },
      installation,
    };
  }

  /** Prepares what a browser visiting `/apps/{slug}/installations/new` is sent back with (Playwright). */
  queueBrowserInstall(
    by: IdentityLike,
    account: TwinAccount,
    options: Partial<InstallOptions> = {},
  ): void {
    this.browserInstalls.push({ by, account, options });
  }

  /** `GET /user/installations` of a user-to-server token. */
  userInstallations(githubUserId: number): TwinInstallation[] {
    return [...(this.userAccess.get(githubUserId) ?? [])]
      .map((id) => this.installations.get(id))
      .filter((i): i is TwinInstallation => i !== undefined && !i.deleted);
  }

  hasInstallations(githubUserId: number): boolean {
    return this.userAccess.has(githubUserId);
  }

  // ---- webhooks --------------------------------------------------------------------------------

  private repoOf(item: TwinItem): TwinRepo {
    return this.repo(item.repoId);
  }

  /** A signed delivery of any event: the building block of the helpers below. */
  webhook(
    event: string,
    payload: unknown,
    options: { deliveryId?: string; signature?: SignatureMode; secret?: string } = {},
  ): WebhookRequest {
    return buildWebhook(event, payload, {
      secret: options.secret ?? this.webhookSecret,
      ...(options.deliveryId ? { deliveryId: options.deliveryId } : {}),
      ...(options.signature ? { signature: options.signature } : {}),
    });
  }

  /** Hands a request to the application and remembers what came back. */
  async deliver(
    sink: WebhookSink,
    request: WebhookRequest,
    signature: SignatureMode = 'valid',
  ): Promise<number> {
    const { status } = await sink(request);
    this.deliveries.push({
      event: request.headers['x-github-event'] ?? '',
      deliveryId: request.headers['x-github-delivery'] ?? '',
      status,
      signature,
    });
    return status;
  }

  /** `issues` event for the current state of the issue. */
  issuesEvent(
    action: 'opened' | 'closed' | 'reopened' | 'edited' | 'assigned' | 'deleted' | 'transferred',
    item: TwinItem,
    options: {
      deliveryId?: string;
      signature?: SignatureMode;
      sender?: TwinPerson;
      installationId?: number;
    } = {},
  ): WebhookRequest {
    const repo = this.repoOf(item);
    const payload = issuesPayload(
      action,
      repo,
      item,
      options.installationId ?? repo.installationId,
      options.sender ?? item.author,
    );
    return this.webhook('issues', payload, options);
  }

  pullRequestEvent(
    action: 'opened' | 'closed' | 'reopened' | 'edited' | 'synchronize',
    item: TwinItem,
    options: {
      deliveryId?: string;
      signature?: SignatureMode;
      sender?: TwinPerson;
      installationId?: number;
    } = {},
  ): WebhookRequest {
    const repo = this.repoOf(item);
    const payload = pullRequestPayload(
      action,
      repo,
      item,
      options.installationId ?? repo.installationId,
      options.sender ?? item.author,
    );
    return this.webhook('pull_request', payload, options);
  }

  reviewEvent(
    item: TwinItem,
    index = item.reviews.length - 1,
    options: { deliveryId?: string } = {},
  ): WebhookRequest {
    const review = item.reviews[index];
    if (!review) throw new Error('the pull request has no review in the double');
    const repo = this.repoOf(item);
    return this.webhook(
      'pull_request_review',
      reviewPayload(repo, item, review, repo.installationId),
      options,
    );
  }

  installationEvent(
    action: 'deleted' | 'suspend' | 'unsuspend' | 'created',
    installationId: number,
    options: { deliveryId?: string; signature?: SignatureMode } = {},
  ): WebhookRequest {
    const installation = this.installation(installationId);
    const payload = installationPayload(
      action,
      {
        id: installationId,
        accountId: installation.account.id,
        accountLogin: installation.account.login,
      },
      installation.account,
    );
    return this.webhook('installation', payload, options);
  }

  repositoriesRemovedEvent(
    installationId: number,
    repoIds: number[],
    options: { deliveryId?: string } = {},
  ): WebhookRequest {
    const repos = repoIds.map((id) => this.repo(id));
    const sender = this.installation(installationId).account;
    return this.webhook(
      'installation_repositories',
      installationRepositoriesPayload('removed', installationId, repos, sender),
      options,
    );
  }

  repositoryEvent(
    action: 'archived' | 'deleted' | 'privatized' | 'renamed' | 'transferred',
    repoId: number,
    options: { deliveryId?: string } = {},
  ): WebhookRequest {
    const repo = this.repo(repoId);
    return this.webhook(
      'repository',
      repositoryEventPayload(action, repo, repo.installationId, {
        id: repo.ownerId,
        login: repo.ownerLogin,
      }),
      options,
    );
  }

  private readonly http = new GithubAppHttp(this);

  /** True when the request was answered here. Called by `GithubServer` before its own routes. */
  handle(req: IncomingMessage, res: ServerResponse, url: URL): Promise<boolean> {
    return this.http.handle(req, res, url);
  }

  installationBody(installation: TwinInstallation): Record<string, unknown> {
    return {
      id: installation.id,
      app_id: this.appId,
      account: {
        id: installation.account.id,
        login: installation.account.login,
        type: installation.account.type,
      },
      permissions: installation.permissions,
      repository_selection: installation.repositorySelection,
      suspended_at: installation.suspendedAt,
    };
  }

  repoBody(repo: TwinRepo): Record<string, unknown> {
    return {
      ...repositoryPayload(repo),
      default_branch: repo.defaultBranch,
      disabled: false,
      visibility: repo.private ? 'private' : 'public',
      ...(repo.fork ? { parent: { id: repo.id - 1, full_name: 'upstream/original' } } : {}),
    };
  }
}
