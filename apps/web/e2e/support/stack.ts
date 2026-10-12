import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

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
  BETTER_AUTH_URL: `http://localhost:${API_PORT}`,
  POSTGRES_HOST_PORT: '15432',
  PGBOUNCER_HOST_PORT: '16432',
  REDIS_HOST_PORT: '16379',
  S3_HOST_PORT: '19000',
  SMTP_HOST_PORT: '11025',
  MAILPIT_UI_PORT: '18025',
  // Own subnet and web address: the dev stack keeps 172.29.250.0/24, and api trusts only its web (/32).
  TF_NET_SUBNET: '172.29.251.0/24',
  TF_WEB_IP: '172.29.251.10',
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

/** Stops one service (for example `redis`) of the e2e stack. */
export function stopService(service: string): void {
  compose('stop', service);
}

/** Starts a stopped service of the e2e stack and waits until its healthcheck passes. */
export function startService(service: string): void {
  compose('start', service);
  compose('up', '-d', '--no-recreate', '--no-build', '--wait', service);
}
