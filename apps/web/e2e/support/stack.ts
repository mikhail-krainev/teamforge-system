import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { githubComposeEnv } from './github';

/** Repository root: compose files and `.env` live there. */
export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..');

export const E2E_PROJECT = 'e2e';
const WEB_PORT = process.env.E2E_WEB_PORT ?? '3100';
const API_PORT = process.env.E2E_API_PORT ?? '4100';
export const E2E_WEB_URL = `http://localhost:${WEB_PORT}`;

/**
 * Variables for `docker compose -p e2e`: ports that cannot collide with the dev stack, and the
 * browser-facing origins that match the published web port (CSRF/CORS checks use APP_ORIGIN).
 */
export const E2E_ENV: Record<string, string> = {
  WEB_PORT,
  API_PORT,
  WEB_URL: E2E_WEB_URL,
  // The browser reaches the api only through the web origin (it proxies /api): OAuth callbacks and
  // relative redirects (callbackURL '/profile') must resolve there, not on the api port.
  BETTER_AUTH_URL: E2E_WEB_URL,
  POSTGRES_HOST_PORT: '15432',
  PGBOUNCER_HOST_PORT: '16432',
  REDIS_HOST_PORT: '16379',
  S3_HOST_PORT: '19000',
  SMTP_HOST_PORT: '11025',
  MAILPIT_UI_PORT: '18025',
  // Own subnet and web address: the dev stack keeps 172.29.250.0/24, and api trusts only its web (/32).
  TF_NET_SUBNET: '172.29.251.0/24',
  TF_WEB_IP: '172.29.251.10',
  // Production refuses GITHUB_*_BASE_URL, so api and worker run as development here.
  APP_NODE_ENV: 'development',
  // GitHub sign-in goes to the double the spec starts on the host (support/github.ts).
  ...githubComposeEnv(),
};

/** Runs `docker compose -p e2e <args>` from the repository root and returns its output. */
export function compose(...args: string[]): string {
  return execFileSync('docker', ['compose', '-p', E2E_PROJECT, ...args], {
    cwd: ROOT,
    env: { ...process.env, ...E2E_ENV },
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: 120_000,
  });
}

/**
 * Forgets the sign-in hits of the per-IP limit `authLogin` (10 per 15 minutes, RATE_LIMITS). Every
 * browser of the scenarios comes from the same address, so slices 1-3 use the whole allowance
 * before slice 4 signs in; only the counters of the throwaway e2e Redis are cleared.
 */
export function resetLoginRateLimit(): void {
  compose(
    'exec',
    '-T',
    'redis',
    'sh',
    '-c',
    'redis-cli --user api --pass "$REDIS_API_PASSWORD" --no-auth-warning --scan --pattern "rl:authLogin:*" | ' +
      'xargs -r redis-cli --user api --pass "$REDIS_API_PASSWORD" --no-auth-warning del',
  );
}

/** Stops one service (for example `redis`) of the e2e stack. */
export function stopService(service: string): void {
  compose('stop', service);
}

/** Starts a stopped service of the e2e stack and waits until its healthcheck passes. */
export function startService(service: string): void {
  compose('start', service);
  compose('up', '-d', '--no-recreate', '--no-build', '--wait', service);
}

/**
 * Runs a background job of the worker once, now, instead of waiting for its schedule: the CLI of the
 * worker image (`dist/cli/run-job.js`, apps/api/src/cli) in the running worker container. No HTTP
 * door is involved; the CLI refuses any job that is not on its closed list. Returns the JSON report.
 */
export function runWorkerJob(job: 'matching-auto-add'): unknown {
  const output = compose('exec', '-T', 'worker', 'node', 'dist/cli/run-job.js', job);
  // The report is the last line; the application logs (JSON too) come before it.
  const report = output.trim().split(/\r?\n/).at(-1);
  if (report === undefined || !report.startsWith('{')) {
    throw new Error(`run-job ${job} printed no report: ${output}`);
  }
  return JSON.parse(report);
}
