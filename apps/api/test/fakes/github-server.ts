import { createHash, randomBytes } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';

/**
 * Double of GitHub for sign-in and account linking (docs/plan.md, "Фикстуры"; architecture 7.1:
 * user-to-server OAuth of the same GitHub App). Self-contained (node:http only) so that API tests and
 * Playwright import it alike. Endpoints:
 *   GET  /login/oauth/authorize      issues a code and redirects to `redirect_uri?code&state`
 *   POST /login/oauth/access_token   code -> `ghu_` token (+ refresh token); also grant_type=refresh_token
 *   GET  /user, /user/emails         the identity behind the token
 *   GET  /user/installations         installations of the App visible to the user (configurable)
 * The application is pointed at it with `githubEnv(server)`.
 */
export interface GithubIdentity {
  id: number;
  login: string;
  name: string | null;
  /** Public profile email (`/user` -> `email`), usually null. */
  email: string | null;
  /** `/user/emails`. The primary verified address is what the application stores. */
  emails: { email: string; primary: boolean; verified: boolean; visibility: string | null }[];
  /** Account creation date (FR-GH-09 account age). */
  createdAt: string;
}

/** Deterministic identity from a label: the same label is always the same GitHub account. */
export function githubIdentity(
  label: string,
  overrides: Partial<GithubIdentity> = {},
): GithubIdentity {
  const digest = createHash('sha256').update(`github:${label}`).digest();
  const id = (digest.readUInt32BE(0) % 900_000_000) + 1_000_000;
  const login = overrides.login ?? `gh-${label}`.toLowerCase().replaceAll(/[^a-z0-9-]/g, '-');
  const email = `${login}@users.noreply.example.test`;
  return {
    id,
    login,
    name: label,
    email: null,
    emails: [{ email, primary: true, verified: true, visibility: null }],
    createdAt: '2020-01-15T10:00:00Z',
    ...overrides,
  };
}

export interface RecordedRequest {
  method: string;
  path: string;
  authorization: string | undefined;
  /** Parsed body of POST requests (form or JSON). */
  body: Record<string, string>;
}

export type TokenFailure = 'unverified_user_email' | 'bad_verification_code';

export interface GithubServerOptions {
  /** Interface to listen on; `0.0.0.0` when containers must reach the double (Playwright). */
  host?: string;
  port?: number;
  /** Host name used in the URLs the application sees (default 127.0.0.1). */
  publicHost?: string;
  clientId?: string;
  clientSecret?: string;
}

export interface GithubServer {
  /** Origin of the double: it serves both the OAuth pages and the REST API. */
  baseUrl: string;
  clientId: string;
  clientSecret: string;
  requests: RecordedRequest[];
  /** Access, refresh tokens and codes issued so far (to assert they are neither stored nor logged). */
  issued: { codes: string[]; accessTokens: string[]; refreshTokens: string[] };
  /** The next `/login/oauth/authorize` of a browser signs in as this identity (used once). */
  nextLogin(identity: GithubIdentity): void;
  /** Identity used when nothing is queued. */
  setDefaultIdentity(identity: GithubIdentity): void;
  /**
   * What a user's click on "Authorize" does, without a browser: takes the authorize URL the
   * application returned and gives the callback URL (`redirect_uri?code=..&state=..`).
   */
  approve(authorizeUrl: string, identity: GithubIdentity): string;
  /** The next token exchange fails with this GitHub error (HTTP 200 with an `error` field, as GitHub does). */
  failNextTokenExchange(error: TokenFailure): void;
  setInstallations(installations: { id: number; account: { login: string } }[]): void;
  close(): Promise<void>;
}

const readBody = async (req: IncomingMessage): Promise<Record<string, string>> => {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  const text = Buffer.concat(chunks).toString('utf8');
  if (text === '') return {};
  if ((req.headers['content-type'] ?? '').includes('json')) {
    return Object.fromEntries(
      Object.entries(JSON.parse(text) as Record<string, unknown>).map(([k, v]) => [k, String(v)]),
    );
  }
  return Object.fromEntries(new URLSearchParams(text));
};

const sendJson = (res: ServerResponse, status: number, body: unknown): void => {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(body));
};

interface CodeGrant {
  identity: GithubIdentity;
  redirectUri: string;
}

interface State {
  clientId: string;
  clientSecret: string;
  queue: GithubIdentity[];
  fallback: GithubIdentity;
  codes: Map<string, CodeGrant>;
  tokens: Map<string, GithubIdentity>;
  refresh: Map<string, GithubIdentity>;
  failures: TokenFailure[];
  installations: { id: number; account: { login: string } }[];
  server: GithubServer;
}

const token = (prefix: string): string => `${prefix}_${randomBytes(18).toString('base64url')}`;

function issueCode(state: State, identity: GithubIdentity, redirectUri: string): string {
  const code = randomBytes(10).toString('hex');
  state.codes.set(code, { identity, redirectUri });
  state.server.issued.codes.push(code);
  return code;
}

function authorize(state: State, url: URL, res: ServerResponse): void {
  const redirectUri = url.searchParams.get('redirect_uri') ?? '';
  if (url.searchParams.get('client_id') !== state.clientId || redirectUri === '') {
    res.writeHead(404, { 'content-type': 'text/plain' }).end('Not Found');
    return;
  }
  const identity = state.queue.shift() ?? state.fallback;
  const target = new URL(redirectUri);
  target.searchParams.set('code', issueCode(state, identity, redirectUri));
  const requestedState = url.searchParams.get('state');
  if (requestedState !== null) target.searchParams.set('state', requestedState);
  res.writeHead(302, { location: target.toString() }).end();
}

function issueTokens(state: State, identity: GithubIdentity): Record<string, unknown> {
  const access = token('ghu');
  const refresh = token('ghr');
  state.tokens.set(access, identity);
  state.refresh.set(refresh, identity);
  state.server.issued.accessTokens.push(access);
  state.server.issued.refreshTokens.push(refresh);
  return {
    access_token: access,
    expires_in: 28_800,
    refresh_token: refresh,
    refresh_token_expires_in: 15_811_200,
    token_type: 'bearer',
    scope: '',
  };
}

function exchange(state: State, body: Record<string, string>, res: ServerResponse): void {
  const failure = state.failures.shift();
  if (failure) return sendJson(res, 200, { error: failure, error_description: failure });
  if (body.client_id !== state.clientId || body.client_secret !== state.clientSecret) {
    return sendJson(res, 200, { error: 'incorrect_client_credentials' });
  }
  if (body.grant_type === 'refresh_token') {
    const identity = state.refresh.get(body.refresh_token ?? '');
    state.refresh.delete(body.refresh_token ?? '');
    return identity
      ? sendJson(res, 200, issueTokens(state, identity))
      : sendJson(res, 200, { error: 'bad_refresh_token' });
  }
  const grant = state.codes.get(body.code ?? '');
  state.codes.delete(body.code ?? '');
  if (!grant || (body.redirect_uri !== undefined && body.redirect_uri !== grant.redirectUri)) {
    return sendJson(res, 200, { error: 'bad_verification_code' });
  }
  sendJson(res, 200, issueTokens(state, grant.identity));
}

function api(state: State, path: string, req: IncomingMessage, res: ServerResponse): void {
  const bearer = /^(?:Bearer|token) (.+)$/i.exec(req.headers.authorization ?? '')?.[1] ?? '';
  const identity = state.tokens.get(bearer);
  if (!identity) return sendJson(res, 401, { message: 'Bad credentials' });
  if (path === '/user') {
    return sendJson(res, 200, {
      id: identity.id,
      login: identity.login,
      name: identity.name,
      email: identity.email,
      type: 'User',
      avatar_url: `${state.server.baseUrl}/avatars/${identity.id}`,
      created_at: identity.createdAt,
    });
  }
  if (path === '/user/emails') return sendJson(res, 200, identity.emails);
  if (path === '/user/installations') {
    return sendJson(res, 200, {
      total_count: state.installations.length,
      installations: state.installations,
    });
  }
  sendJson(res, 404, { message: 'Not Found' });
}

async function handle(state: State, req: IncomingMessage, res: ServerResponse): Promise<void> {
  const url = new URL(req.url ?? '/', state.server.baseUrl);
  const body = req.method === 'POST' ? await readBody(req) : {};
  state.server.requests.push({
    method: req.method ?? 'GET',
    path: url.pathname,
    authorization: req.headers.authorization,
    body,
  });
  if (req.method === 'GET' && url.pathname === '/login/oauth/authorize') {
    return authorize(state, url, res);
  }
  if (req.method === 'POST' && url.pathname === '/login/oauth/access_token') {
    return exchange(state, body, res);
  }
  if (req.method === 'GET' && url.pathname.startsWith('/user')) {
    return api(state, url.pathname, req, res);
  }
  sendJson(res, 404, { message: 'Not Found' });
}

function createDouble(state: State, server: Server, baseUrl: string): GithubServer {
  return {
    baseUrl,
    clientId: state.clientId,
    clientSecret: state.clientSecret,
    requests: [],
    issued: { codes: [], accessTokens: [], refreshTokens: [] },
    nextLogin: (identity) => void state.queue.push(identity),
    setDefaultIdentity: (identity) => void (state.fallback = identity),
    approve(authorizeUrl, identity) {
      const url = new URL(authorizeUrl);
      const redirectUri = url.searchParams.get('redirect_uri') ?? '';
      const target = new URL(redirectUri);
      target.searchParams.set('code', issueCode(state, identity, redirectUri));
      const requestedState = url.searchParams.get('state');
      if (requestedState !== null) target.searchParams.set('state', requestedState);
      return target.toString();
    },
    failNextTokenExchange: (error) => void state.failures.push(error),
    setInstallations: (installations) => void (state.installations = installations),
    close: () =>
      new Promise((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}

export async function startGithubServer(options: GithubServerOptions = {}): Promise<GithubServer> {
  const state: State = {
    clientId: options.clientId ?? 'Iv1.testclientid0001',
    clientSecret: options.clientSecret ?? 'test-github-client-secret-0001',
    queue: [],
    fallback: githubIdentity('default'),
    codes: new Map(),
    tokens: new Map(),
    refresh: new Map(),
    failures: [],
    installations: [],
    server: undefined as unknown as GithubServer,
  };
  const server: Server = createServer((req, res) => {
    handle(state, req, res).catch(() => sendJson(res, 500, { message: 'double failure' }));
  });
  await new Promise<void>((resolve) =>
    server.listen(options.port ?? 0, options.host ?? '127.0.0.1', resolve),
  );
  const bound = server.address();
  const port = typeof bound === 'object' && bound ? bound.port : 0;
  state.server = createDouble(state, server, `http://${options.publicHost ?? '127.0.0.1'}:${port}`);
  return state.server;
}

/**
 * Environment that points the application at the double. The two base URLs are the seam the
 * backend has to honour (default `https://github.com` and `https://api.github.com`); the client
 * id and secret are the GitHub App settings of architecture 7.1.
 */
export function githubEnv(server: GithubServer): Record<string, string> {
  return {
    GITHUB_APP_CLIENT_ID: server.clientId,
    GITHUB_APP_CLIENT_SECRET: server.clientSecret,
    GITHUB_OAUTH_BASE_URL: server.baseUrl,
    GITHUB_API_BASE_URL: server.baseUrl,
  };
}
