import { randomBytes } from 'node:crypto';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';

/** One GitHub account behind the double. */
export interface DoubleIdentity {
  id: number;
  login: string;
  email: string;
}

export interface GithubDouble {
  baseUrl: string;
  clientId: string;
  clientSecret: string;
  /** Access tokens handed out so far (to prove they are not stored in clear text). */
  accessTokens: string[];
  /** What a user's click on "Authorize" produces: the callback URL with code and state. */
  approve(authorizeUrl: string, identity: DoubleIdentity): string;
  close(): Promise<void>;
}

interface DoubleState {
  clientSecret: string;
  codes: Map<string, DoubleIdentity>;
  tokens: Map<string, DoubleIdentity>;
  issued: string[];
}

const send = (res: ServerResponse, status: number, body: unknown): void => {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
};

async function readForm(req: IncomingMessage): Promise<URLSearchParams> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  return new URLSearchParams(Buffer.concat(chunks).toString('utf8'));
}

async function exchange(
  state: DoubleState,
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  const form = await readForm(req);
  const code = form.get('code') ?? '';
  const identity = state.codes.get(code);
  state.codes.delete(code);
  if (form.get('client_secret') !== state.clientSecret || identity === undefined) {
    return send(res, 200, { error: 'bad_verification_code' });
  }
  const accessToken = `ghu_${randomBytes(16).toString('hex')}`;
  state.tokens.set(accessToken, identity);
  state.issued.push(accessToken);
  send(res, 200, {
    access_token: accessToken,
    refresh_token: `ghr_${randomBytes(16).toString('hex')}`,
    expires_in: 28_800,
    refresh_token_expires_in: 15_811_200,
    token_type: 'bearer',
    scope: '',
  });
}

function api(state: DoubleState, req: IncomingMessage, res: ServerResponse, path: string): void {
  const bearer = /^Bearer (.+)$/.exec(req.headers.authorization ?? '')?.[1] ?? '';
  const identity = state.tokens.get(bearer);
  if (identity === undefined) return send(res, 401, { message: 'Bad credentials' });
  if (path === '/user') {
    return send(res, 200, { id: identity.id, login: identity.login, name: null, email: null });
  }
  send(res, 200, [{ email: identity.email, primary: true, verified: true }]);
}

function route(state: DoubleState, req: IncomingMessage, res: ServerResponse): void {
  const path = new URL(req.url ?? '/', 'http://double').pathname;
  if (req.method === 'POST' && path === '/login/oauth/access_token') {
    exchange(state, req, res).catch(() => send(res, 500, {}));
  } else if (req.method === 'GET' && (path === '/user' || path === '/user/emails')) {
    api(state, req, res, path);
  } else {
    send(res, 404, { message: 'Not Found' });
  }
}

function approveUrl(state: DoubleState, authorizeUrl: string, identity: DoubleIdentity): string {
  const url = new URL(authorizeUrl);
  const target = new URL(url.searchParams.get('redirect_uri') ?? '');
  const code = randomBytes(8).toString('hex');
  state.codes.set(code, identity);
  target.searchParams.set('code', code);
  target.searchParams.set('state', url.searchParams.get('state') ?? '');
  return target.toString();
}

/**
 * Minimal GitHub for the Better Auth spike: token exchange, `/user`, `/user/emails`. The full
 * double for the slice tests is `test/fakes/github-server.ts`; this one only has what the spike
 * needs, so the spike does not depend on that work.
 */
export async function startGithubDouble(): Promise<GithubDouble> {
  const clientId = 'Iv1.spike0000000001';
  const clientSecret = 'spike-client-secret-0001';
  const state: DoubleState = { clientSecret, codes: new Map(), tokens: new Map(), issued: [] };
  const server = createServer((req, res) => route(state, req, res));
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  const port = typeof address === 'object' && address !== null ? address.port : 0;
  return {
    baseUrl: `http://127.0.0.1:${port}`,
    clientId,
    clientSecret,
    accessTokens: state.issued,
    approve: (authorizeUrl, identity) => approveUrl(state, authorizeUrl, identity),
    close: () =>
      new Promise((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}
