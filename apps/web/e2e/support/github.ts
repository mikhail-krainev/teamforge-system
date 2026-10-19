import { generateKeyPairSync } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { BrowserContext } from '@playwright/test';
import {
  githubIdentity,
  startGithubServer,
  type GithubIdentity,
  type GithubServer,
} from '../../../api/test/fakes/github-server';

export { githubIdentity, type GithubIdentity, type GithubServer };

/** Fixed port: the api container is configured with it before the stack starts. */
export const GITHUB_DOUBLE_PORT = Number(process.env.E2E_GITHUB_PORT ?? '4900');
/** How containers reach the host (Docker Desktop; on Linux add `extra_hosts: host.docker.internal:host-gateway`). */
export const GITHUB_DOUBLE_HOST = 'host.docker.internal';

const DEFAULT_CLIENT_ID = 'Iv1.testclientid0001';
const DEFAULT_CLIENT_SECRET = 'test-github-client-secret-0001';

/** GitHub App settings of the e2e stack (slice 6: installation, webhooks); the api and the worker get them from `githubComposeEnv()`. */
export const E2E_GITHUB_APP_ID = 424243;
export const E2E_GITHUB_APP_SLUG = 'teamforge-e2e';
export const E2E_GITHUB_WEBHOOK_SECRET = 'e2e-github-webhook-secret-0001';

const KEY_FILE = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../.e2e/e2e-github-app-key.pem',
);

/**
 * The private key of the double's App. The stack is started before the specs run, so the key must be the
 * same in the process that builds the compose environment and in the worker that starts the double: it is
 * generated once into `apps/web/test-results/` (ignored by git, `*.pem` too) and read from there.
 */
export function e2eAppPrivateKey(): string {
  if (!existsSync(KEY_FILE)) {
    mkdirSync(path.dirname(KEY_FILE), { recursive: true });
    const pair = generateKeyPairSync('rsa', {
      modulusLength: 2048,
      publicKeyEncoding: { type: 'spki', format: 'pem' },
      privateKeyEncoding: { type: 'pkcs1', format: 'pem' },
    });
    try {
      writeFileSync(KEY_FILE, pair.privateKey, { flag: 'wx' });
    } catch {
      // another process wrote it first: read that one
    }
  }
  return readFileSync(KEY_FILE, 'utf8');
}

let double: GithubServer | undefined;

/**
 * Starts the GitHub double on 0.0.0.0:E2E_GITHUB_PORT (once per worker). The compose stack must
 * run api (and worker) with `githubComposeEnv()`; see the header comment of slice2.spec.ts.
 */
export async function githubDouble(): Promise<GithubServer> {
  double ??= await startGithubServer({
    host: '0.0.0.0',
    port: GITHUB_DOUBLE_PORT,
    publicHost: GITHUB_DOUBLE_HOST,
    clientId: process.env.E2E_GITHUB_CLIENT_ID ?? DEFAULT_CLIENT_ID,
    clientSecret: process.env.E2E_GITHUB_CLIENT_SECRET ?? DEFAULT_CLIENT_SECRET,
    appId: E2E_GITHUB_APP_ID,
    appSlug: E2E_GITHUB_APP_SLUG,
    webhookSecret: E2E_GITHUB_WEBHOOK_SECRET,
    privateKeyPem: e2eAppPrivateKey(),
  });
  return double;
}

export async function stopGithubDouble(): Promise<void> {
  const running = double;
  double = undefined;
  await running?.close();
}

/**
 * Environment the e2e stack needs for GitHub sign-in against the double (the orchestrator puts it
 * into the compose environment of api and worker). Client id/secret are the double's defaults.
 */
export function githubComposeEnv(): Record<string, string> {
  const origin = `http://${GITHUB_DOUBLE_HOST}:${GITHUB_DOUBLE_PORT}`;
  return {
    GITHUB_APP_CLIENT_ID: process.env.E2E_GITHUB_CLIENT_ID ?? DEFAULT_CLIENT_ID,
    GITHUB_APP_CLIENT_SECRET: process.env.E2E_GITHUB_CLIENT_SECRET ?? DEFAULT_CLIENT_SECRET,
    GITHUB_OAUTH_BASE_URL: origin,
    GITHUB_API_BASE_URL: origin,
    // slice 6: the GitHub App itself (docker-compose.yml passes them to api and worker, S6-03)
    GITHUB_APP_ID: String(E2E_GITHUB_APP_ID),
    GITHUB_APP_SLUG: E2E_GITHUB_APP_SLUG,
    GITHUB_APP_PRIVATE_KEY: e2eAppPrivateKey(),
    GITHUB_WEBHOOK_SECRET: E2E_GITHUB_WEBHOOK_SECRET,
  };
}

/**
 * The api sends the browser to `http://host.docker.internal:<port>/login/oauth/authorize`, a name
 * that only containers (and Docker Desktop hosts) resolve. Browser requests to it are redirected
 * to 127.0.0.1, where the double listens.
 */
export async function routeGithubDoubleToLoopback(context: BrowserContext): Promise<void> {
  await context.route(
    (url) => url.hostname === GITHUB_DOUBLE_HOST,
    (route) =>
      route.continue({ url: route.request().url().replace(GITHUB_DOUBLE_HOST, '127.0.0.1') }),
  );
}

/**
 * The install URL of the App points at github.com (`/apps/<slug>/installations/new?state=...`): the
 * browser of the test is sent to the double instead, which answers with the redirect to Callback URL #1
 * of the App (the double knows who "installs" from `double.app.queueBrowserInstall`).
 */
export async function routeInstallDialogToDouble(context: BrowserContext): Promise<void> {
  await context.route(
    (url) =>
      /^\/apps\/[^/]+\/installations\/new$/.test(url.pathname) && url.hostname !== '127.0.0.1',
    (route) => {
      const original = new URL(route.request().url());
      const target = new URL(
        `http://127.0.0.1:${GITHUB_DOUBLE_PORT}${original.pathname}${original.search}`,
      );
      return route.fulfill({ status: 302, headers: { location: target.toString() } });
    },
  );
}
