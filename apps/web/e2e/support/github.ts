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
