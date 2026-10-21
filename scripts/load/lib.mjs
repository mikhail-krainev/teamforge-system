// Helpers of the load-test preparation (docs/release.md, section 5). Node 22+, no dependencies.
// Talks to the isolated stack of scripts/load/ports.env (compose project `tf-release`).
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';

export const API = process.env.LOAD_API_URL ?? 'http://localhost:24000';
export const ORIGIN = process.env.LOAD_ORIGIN ?? 'http://localhost:23000';
export const MAILPIT = process.env.LOAD_MAILPIT_URL ?? 'http://localhost:28025';
const PROJECT = process.env.LOAD_COMPOSE_PROJECT ?? 'tf-release';

const composeArgs = [
  'compose',
  '-p',
  PROJECT,
  '--env-file',
  '.env',
  '--env-file',
  'scripts/load/ports.env',
  '-f',
  'docker-compose.yml',
  '-f',
  'scripts/load/compose.load.yml',
];

/** Runs `docker compose ... <args>` from the repository root (the current directory) and returns stdout. */
export function compose(args, input) {
  return execFileSync('docker', [...composeArgs, ...args], {
    encoding: 'utf8',
    input,
    stdio: ['pipe', 'pipe', 'pipe'],
    timeout: 60_000,
  });
}

/** One SQL statement as the PostgreSQL superuser inside the container; rows come back as arrays of text. */
export function sql(statement) {
  const out = compose(
    [
      'exec',
      '-T',
      'postgres',
      'psql',
      '-U',
      'postgres',
      '-d',
      'teamforge',
      '-At',
      '-F',
      '\t',
      '-v',
      'ON_ERROR_STOP=1',
    ],
    statement,
  );
  return out
    .split('\n')
    .filter((l) => l !== '')
    .map((l) => l.split('\t'));
}

/** Forgets every rate-limit counter (`rl:*`) of the throwaway Redis, so that many sign-ins fit the per-IP limits. */
export function resetRateLimits() {
  compose([
    'exec',
    '-T',
    'redis',
    'sh',
    '-c',
    'redis-cli --user api --pass "$REDIS_API_PASSWORD" --no-auth-warning --scan --pattern "rl:*" | ' +
      'xargs -r redis-cli --user api --pass "$REDIS_API_PASSWORD" --no-auth-warning del >/dev/null',
  ]);
}

/** A JSON call to the api with a session cookie; state-changing calls carry the Origin (CSRF) and a fresh Idempotency-Key. */
export async function call(method, path, { cookie, body, key } = {}) {
  const headers = { Origin: ORIGIN };
  if (cookie) headers.Cookie = cookie;
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  if (method !== 'GET' && !path.startsWith('/auth/'))
    headers['Idempotency-Key'] = key ?? randomUUID();
  const response = await fetch(`${API}/api${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  let json;
  try {
    json = text === '' ? undefined : JSON.parse(text);
  } catch {
    json = undefined;
  }
  return { status: response.status, json, text, headers: response.headers };
}

export function expectStatus(result, expected, what) {
  const list = Array.isArray(expected) ? expected : [expected];
  if (!list.includes(result.status)) {
    throw new Error(`${what}: HTTP ${result.status} ${result.text.slice(0, 300)}`);
  }
  return result.json;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function mailpit(path) {
  const response = await fetch(`${MAILPIT}${path}`);
  if (!response.ok) throw new Error(`Mailpit ${path}: HTTP ${response.status}`);
  return response.json();
}

/** The one-time token of the sign-in mail sent to `email` (polls Mailpit; the mail is chosen by recipient and subject). */
async function signInToken(email, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const found = await mailpit(
      `/api/v1/search?query=${encodeURIComponent(`to:"${email}"`)}&limit=20`,
    );
    for (const summary of found.messages ?? []) {
      if (summary.Subject !== 'Вход в Teamforge') continue;
      const message = await mailpit(`/api/v1/message/${summary.ID}`);
      const match = /token=([A-Za-z0-9._~%-]+)/.exec(message.Text);
      if (match) return decodeURIComponent(match[1]);
    }
    if (Date.now() > deadline) throw new Error(`no sign-in mail for ${email}`);
    await sleep(300);
  }
}

/** Magic-link sign-in as a browser would do it; returns the `Cookie` header value of the session. */
export async function signIn(email) {
  resetRateLimits();
  const sent = await call('POST', '/auth/sign-in/magic-link', {
    body: { email, callbackURL: '/profile' },
  });
  expectStatus(sent, 200, `magic link request for ${email}`);
  const token = await signInToken(email);
  const confirmed = await call('POST', '/auth/magic-link/confirm', { body: { token } });
  expectStatus(confirmed, 200, `magic link confirm for ${email}`);
  const cookies = confirmed.headers.getSetCookie().map((c) => c.split(';')[0]);
  if (cookies.length === 0) throw new Error('no session cookie');
  return cookies.join('; ');
}

/** Accepts the current consent text (FR-AUTH-03); every /v1 route except a few needs it. */
export async function acceptConsent(cookie) {
  const current = expectStatus(
    await call('GET', '/v1/consent/current', { cookie }),
    200,
    'consent text',
  );
  expectStatus(
    await call('POST', '/v1/me/consents', {
      cookie,
      body: { version: current.version, textHash: current.textHash },
    }),
    [200, 201],
    'accept consent',
  );
}

/**
 * A signed-in person with consent and a linked GitHub identity (the only kind that may join a team,
 * FR-AUTH-05). GitHub linking is done with two columns of auth."user", as the integration fixtures do
 * (apps/api/test/fixtures/world.ts), because the real flow needs a GitHub OAuth page.
 */
let githubSerial = 0;

/** A GitHub id that is unique across runs (the column is unique and the stack keeps its data between runs). */
const nextGithubId = () => Date.now() * 1000 + (githubSerial++ % 1000);

export async function createMember(label, runId) {
  const githubId = nextGithubId();
  const email = `${label}-${runId}@example.test`;
  const cookie = await signIn(email);
  await acceptConsent(cookie);
  const me = expectStatus(await call('GET', '/v1/me', { cookie }), 200, 'me');
  sql(
    `UPDATE auth."user" SET github_user_id = ${Number(githubId)}, github_login = '${label}-${runId}' WHERE id = '${me.id}'`,
  );
  return { id: me.id, email, cookie };
}
