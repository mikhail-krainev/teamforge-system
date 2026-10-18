import { createHash, createVerify, randomBytes } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { GithubAppTwin } from './github-app.js';
import {
  ALL_READ,
  DEFAULT_QUOTA,
  HOUR_MS,
  JWT_MAX_LIFETIME_SECONDS,
  iso,
  paginate,
  sendJson,
  type TwinCall,
  type TwinInstallation,
  type TwinItem,
  type TwinRepo,
} from './github-app-types.js';
import { itemObject } from './github-webhooks.js';

/** REST surface of the GitHub App double: routing, authentication, limits, ETag. State lives in the twin. */
export class GithubAppHttp {
  constructor(private readonly twin: GithubAppTwin) {}

  // ---- HTTP surface ----------------------------------------------------------------------------

  /** True when the request was answered here. Called by `GithubServer` before its own routes. */
  async handle(req: IncomingMessage, res: ServerResponse, url: URL): Promise<boolean> {
    const path = url.pathname;
    const isInstallDialog =
      req.method === 'GET' && /^\/apps\/[^/]+\/installations\/new$/.test(path);
    const isAppEndpoint = /^\/(app|installation|repositories|repos)(\/|$)/.test(path);
    const isAccountEndpoint =
      /^\/user\/\d+$/.test(path) || /^\/users\/[^/]+\/events\/public$/.test(path);
    if (isInstallDialog) {
      this.installDialog(url, res);
      return true;
    }
    if (!isAppEndpoint && !isAccountEndpoint) return false;
    const query = Object.fromEntries(url.searchParams);
    const auth = this.authenticate(req);
    const record = (status: number): void => {
      this.twin.calls.push({
        method: req.method ?? 'GET',
        path,
        query,
        auth: auth.kind,
        installationId: auth.installationId,
        status,
      });
    };
    const answer = (status: number, body: unknown, headers: Record<string, string> = {}): true => {
      record(status);
      sendJson(res, status, body, { ...this.quotaHeaders(), ...headers });
      return true;
    };
    const limited = this.limitFailure(path);
    if (limited) return answer(limited.status, limited.body, limited.headers);
    if (isAccountEndpoint) return this.accountEndpoint(path, answer);
    return this.appEndpoint(req, url, path, query, auth, answer, res, record);
  }

  private installDialog(url: URL, res: ServerResponse): void {
    const next = this.twin.browserInstalls.shift();
    if (!next || !this.twin.callbackUrl) {
      res
        .writeHead(404, { 'content-type': 'text/plain' })
        .end('no installation queued in the double');
      return;
    }
    const state = url.searchParams.get('state') ?? '';
    const result = this.twin.install(next.by, next.account, { ...next.options, state });
    const target = new URL(this.twin.callbackUrl);
    for (const [key, value] of Object.entries(result.query)) target.searchParams.set(key, value);
    res.writeHead(302, { location: target.toString() }).end();
  }

  private authenticate(req: IncomingMessage): {
    kind: TwinCall['auth'];
    installationId: number | undefined;
    valid: boolean;
    reason?: string;
  } {
    const header = req.headers.authorization ?? '';
    const bearer = /^(?:Bearer|token) (.+)$/i.exec(header)?.[1];
    if (!bearer) return { kind: 'none', installationId: undefined, valid: false };
    if (bearer.startsWith('ghs_')) {
      const record = this.twin.tokens.get(bearer);
      const live = record !== undefined && record.expiresAt > this.twin.clock.now().getTime();
      return { kind: 'installation-token', installationId: record?.installationId, valid: live };
    }
    if (bearer.split('.').length === 3) {
      const reason = this.jwtProblem(bearer);
      return {
        kind: 'app-jwt',
        installationId: undefined,
        valid: reason === undefined,
        ...(reason ? { reason } : {}),
      };
    }
    return { kind: 'user-token', installationId: undefined, valid: true };
  }

  /** Why an App JWT is refused, or undefined when it is good. Real wall clock: the JWT library uses it. */
  private jwtProblem(jwt: string): string | undefined {
    const [head = '', body = '', signature = ''] = jwt.split('.');
    try {
      const header = JSON.parse(Buffer.from(head, 'base64url').toString('utf8')) as {
        alg?: string;
      };
      if (header.alg !== 'RS256') return 'alg';
      const verifier = createVerify('RSA-SHA256').update(`${head}.${body}`);
      if (!verifier.verify(this.twin.publicKey, Buffer.from(signature, 'base64url')))
        return 'signature';
      const claims = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) as {
        iss?: string | number;
        iat?: number;
        exp?: number;
      };
      const nowSeconds = Math.floor(Date.now() / 1000);
      if (String(claims.iss) !== String(this.twin.appId)) return 'iss';
      if (typeof claims.exp !== 'number' || claims.exp <= nowSeconds) return 'expired';
      if (claims.exp > nowSeconds + JWT_MAX_LIFETIME_SECONDS + 5) return 'too-long';
      if (typeof claims.iat !== 'number' || claims.iat > nowSeconds + 5) return 'iat';
      return undefined;
    } catch {
      return 'malformed';
    }
  }

  private quotaHeaders(): Record<string, string> {
    const now = this.twin.clock.now().getTime();
    if (this.twin.quotaResetAt !== 0 && now >= this.twin.quotaResetAt) {
      this.twin.quotaRemaining = DEFAULT_QUOTA;
      this.twin.quotaResetAt = 0;
    }
    const reset =
      this.twin.quotaResetAt === 0
        ? Math.floor(now / 1000) + 3600
        : Math.floor(this.twin.quotaResetAt / 1000);
    return {
      'x-ratelimit-limit': String(DEFAULT_QUOTA),
      'x-ratelimit-remaining': String(this.twin.quotaRemaining),
      'x-ratelimit-reset': String(reset),
      'x-ratelimit-resource': 'core',
    };
  }

  private limitFailure(
    path: string,
  ): { status: number; body: unknown; headers: Record<string, string> } | undefined {
    const forcedAt = this.twin.forcedFailures.findIndex((f) => !f.matcher || f.matcher.test(path));
    if (forcedAt >= 0) {
      const [forced] = this.twin.forcedFailures.splice(forcedAt, 1);
      if (forced) {
        return {
          status: forced.status,
          body: forced.body ?? { message: 'forced failure of the double' },
          headers:
            forced.retryAfter === undefined ? {} : { 'retry-after': String(forced.retryAfter) },
        };
      }
    }
    const now = this.twin.clock.now().getTime();
    if (now < this.twin.blockedUntil) {
      return {
        status: this.twin.blockedStatus,
        body: {
          message:
            'You have exceeded a secondary rate limit. Please wait a few minutes before you try again.',
        },
        headers: { 'retry-after': String(Math.ceil((this.twin.blockedUntil - now) / 1000)) },
      };
    }
    this.quotaHeaders();
    if (this.twin.quotaRemaining <= 0) {
      return { status: 403, body: { message: 'API rate limit exceeded' }, headers: {} };
    }
    return undefined;
  }

  private spend(): void {
    if (this.twin.quotaRemaining > 0) this.twin.quotaRemaining -= 1;
  }

  private accountEndpoint(path: string, answer: Answer): true {
    this.spend();
    const byId = /^\/user\/(\d+)$/.exec(path);
    if (byId) {
      const account = this.twin.accounts.get(Number(byId[1]));
      if (!account) return answer(404, { message: 'Not Found' });
      return answer(200, {
        id: account.id,
        login: account.login,
        type: account.type,
        created_at: account.createdAt ?? '2020-01-15T10:00:00Z',
        public_repos: account.publicRepos ?? 3,
      });
    }
    const login = decodeURIComponent(/^\/users\/([^/]+)\//.exec(path)?.[1] ?? '');
    const account = [...this.twin.accounts.values()].find(
      (a) => a.login.toLowerCase() === login.toLowerCase(),
    );
    if (!account) return answer(404, { message: 'Not Found' });
    const count = account.publicEvents ?? 5;
    return answer(
      200,
      Array.from({ length: Math.min(count, 30) }, (_, i) => ({
        id: String(i + 1),
        type: 'PushEvent',
      })),
    );
  }

  private appEndpoint(
    req: IncomingMessage,
    url: URL,
    path: string,
    query: Record<string, string>,
    auth: ReturnType<GithubAppHttp['authenticate']>,
    answer: Answer,
    res: ServerResponse,
    record: (status: number) => void,
  ): true {
    const method = req.method ?? 'GET';
    const needJwt = path === '/app' || path.startsWith('/app/');
    if (needJwt) {
      if (auth.kind !== 'app-jwt' || !auth.valid) {
        return answer(401, {
          message: 'A JSON web token could not be decoded',
          documentation_url: 'https://docs.github.com/rest',
        });
      }
      return this.jwtEndpoint(method, path, answer);
    }
    if (auth.kind !== 'installation-token' || !auth.valid || auth.installationId === undefined) {
      return answer(401, { message: 'Bad credentials' });
    }
    const installation = this.twin.installations.get(auth.installationId);
    if (!installation || installation.deleted) return answer(401, { message: 'Bad credentials' });
    if (installation.suspendedAt)
      return answer(403, { message: 'This installation has been suspended' });
    this.spend();
    return this.installationEndpoint(
      installation,
      method,
      url,
      path,
      query,
      req,
      answer,
      res,
      record,
    );
  }

  private jwtEndpoint(method: string, path: string, answer: Answer): true {
    if (method === 'GET' && path === '/app') {
      return answer(200, {
        id: this.twin.appId,
        slug: this.twin.slug,
        name: 'Teamforge test',
        permissions: ALL_READ,
      });
    }
    const tokenRoute = /^\/app\/installations\/(\d+)\/access_tokens$/.exec(path);
    if (method === 'POST' && tokenRoute) {
      const installation = this.twin.installations.get(Number(tokenRoute[1]));
      if (!installation || installation.deleted) return answer(404, { message: 'Not Found' });
      if (installation.suspendedAt)
        return answer(403, { message: 'This installation has been suspended' });
      const token = `ghs_${randomBytes(18).toString('base64url')}`;
      const expiresAt = this.twin.clock.now().getTime() + HOUR_MS;
      this.twin.tokens.set(token, { installationId: installation.id, expiresAt });
      this.twin.tokenCount.set(
        installation.id,
        (this.twin.tokenCount.get(installation.id) ?? 0) + 1,
      );
      return answer(201, {
        token,
        expires_at: iso(new Date(expiresAt)),
        permissions: installation.permissions,
        repository_selection: installation.repositorySelection,
      });
    }
    const one = /^\/app\/installations\/(\d+)$/.exec(path);
    if (method === 'GET' && one) {
      const installation = this.twin.installations.get(Number(one[1]));
      if (!installation || installation.deleted) return answer(404, { message: 'Not Found' });
      return answer(200, this.twin.installationBody(installation));
    }
    return answer(404, { message: 'Not Found' });
  }

  private visibleRepo(installation: TwinInstallation, id: number): TwinRepo | undefined {
    const repo = this.twin.repos.get(id);
    return repo && repo.installationId === installation.id && !repo.gone ? repo : undefined;
  }

  private installationEndpoint(
    installation: TwinInstallation,
    method: string,
    url: URL,
    path: string,
    query: Record<string, string>,
    req: IncomingMessage,
    answer: Answer,
    res: ServerResponse,
    record: (status: number) => void,
  ): true {
    if (method !== 'GET') return answer(404, { message: 'Not Found' });
    if (path === '/installation/repositories') {
      const all = [...this.twin.repos.values()].filter(
        (r) => r.installationId === installation.id && !r.gone,
      );
      const page = paginate(all, query, url);
      return answer(
        200,
        { total_count: all.length, repositories: page.items.map((r) => this.twin.repoBody(r)) },
        page.headers,
      );
    }
    const match = /^\/(?:repositories\/(\d+)|repos\/([^/]+)\/([^/]+))(\/.*)?$/.exec(path);
    if (!match) return answer(404, { message: 'Not Found' });
    const rest = match[4] ?? '';
    const repo = match[1]
      ? this.visibleRepo(installation, Number(match[1]))
      : [...this.twin.repos.values()].find(
          (r) =>
            r.installationId === installation.id &&
            !r.gone &&
            r.fullName.toLowerCase() === `${match[2]}/${match[3]}`.toLowerCase(),
        );
    if (!repo) return answer(404, { message: 'Not Found' });
    return this.repoEndpoint(installation, repo, rest, query, url, req, answer, res, record);
  }

  private contributors(
    repo: TwinRepo,
    query: Record<string, string>,
    url: URL,
    answer: Answer,
  ): true {
    const page = paginate(repo.contributors, query, url);
    const body = page.items.map((c) => ({
      id: c.id,
      login: c.login,
      type: 'User',
      contributions: c.contributions,
    }));
    return answer(200, body, page.headers);
  }

  private workflowRuns(
    installation: TwinInstallation,
    repo: TwinRepo,
    query: Record<string, string>,
    url: URL,
    answer: Answer,
  ): true {
    if (installation.permissions.actions === undefined) {
      return answer(403, { message: 'Resource not accessible by integration' });
    }
    const runs = (this.twin.runs.get(repo.id) ?? []).slice().reverse();
    const page = paginate(runs, query, url);
    const workflowRuns = page.items.map((r) => ({
      id: r.id,
      status: r.conclusion === null ? 'in_progress' : 'completed',
      conclusion: r.conclusion,
      head_branch: r.headBranch,
      created_at: r.createdAt,
    }));
    return answer(200, { total_count: runs.length, workflow_runs: workflowRuns }, page.headers);
  }

  private repoEndpoint(
    installation: TwinInstallation,
    repo: TwinRepo,
    rest: string,
    query: Record<string, string>,
    url: URL,
    req: IncomingMessage,
    answer: Answer,
    res: ServerResponse,
    record: (status: number) => void,
  ): true {
    if (rest === '') return answer(200, this.twin.repoBody(repo));
    if (rest === '/contributors') return this.contributors(repo, query, url, answer);
    if (rest === '/actions/runs') return this.workflowRuns(installation, repo, query, url, answer);
    const all = (this.twin.items.get(repo.id) ?? []).filter((i) => !i.gone);
    if (rest === '/issues' || rest === '/pulls') {
      return this.listItems(repo, all, rest === '/pulls', query, url, req, answer, res, record);
    }
    const single = /^\/pulls\/(\d+)(\/reviews)?$/.exec(rest);
    const issueOne = /^\/issues\/(\d+)$/.exec(rest);
    const number = Number(single?.[1] ?? issueOne?.[1]);
    const found = all.find((i) => i.number === number && (single ? i.kind === 'pr' : true));
    if ((!single && !issueOne) || !found) return answer(404, { message: 'Not Found' });
    if (single?.[2]) {
      return answer(
        200,
        found.reviews.map((r, i) => ({
          id: i + 1,
          user: { id: r.reviewer.id, login: r.reviewer.login },
          state: r.state.toUpperCase(),
          submitted_at: r.submittedAt,
        })),
      );
    }
    return answer(200, itemObject(repo, found));
  }

  private listItems(
    repo: TwinRepo,
    all: TwinItem[],
    pullsOnly: boolean,
    query: Record<string, string>,
    url: URL,
    req: IncomingMessage,
    answer: Answer,
    res: ServerResponse,
    record: (status: number) => void,
  ): true {
    const list = filterItems(all, pullsOnly, query);
    const page = paginate(list, query, url);
    const body = page.items.map((i) => {
      const object = itemObject(repo, i);
      if (pullsOnly) {
        // the pull request list omits the line counts; `GET /pulls/{n}` has them
        delete object.additions;
        delete object.deletions;
        delete object.merged;
        return object;
      }
      return i.kind === 'pr'
        ? {
            ...object,
            pull_request: {
              url: `${this.twin.options.baseUrl()}/repositories/${repo.id}/pulls/${i.number}`,
            },
          }
        : object;
    });
    const etag = `W/"${createHash('sha1').update(JSON.stringify(body)).digest('hex')}"`;
    if (url.searchParams.get('page') === null || url.searchParams.get('page') === '1') {
      if (req.headers['if-none-match'] === etag) {
        record(304);
        res.writeHead(304, { etag, ...this.quotaHeaders() });
        res.end();
        // a 304 costs no quota: give back what `spend` took
        this.twin.quotaRemaining = Math.min(DEFAULT_QUOTA, this.twin.quotaRemaining + 1);
        return true;
      }
    }
    return answer(200, body, { etag, ...page.headers });
  }
}

type Answer = (status: number, body: unknown, headers?: Record<string, string>) => true;

/** `state`, `since`, `sort` and `direction` of the issue and pull request lists. */
function filterItems(
  all: TwinItem[],
  pullsOnly: boolean,
  query: Record<string, string>,
): TwinItem[] {
  const state = query.state ?? 'open';
  const since = query.since ? Date.parse(query.since) : 0;
  const direction = query.direction === 'asc' ? 1 : -1;
  const key = query.sort === 'updated' ? 'updatedAt' : 'createdAt';
  return all
    .filter((i) => (pullsOnly ? i.kind === 'pr' : true))
    .filter((i) => state === 'all' || i.state === state)
    .filter((i) => Date.parse(i.updatedAt) >= since)
    .sort(
      (a, b) =>
        direction * (Date.parse(a[key]) - Date.parse(b[key])) || direction * (a.number - b.number),
    );
}
