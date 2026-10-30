// Connection and safety checks of the demo seed (docs/local-run.md, "Демо-данные").
// The seed wipes and rewrites rows, so it runs only against a database on this machine.
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';

const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '[::1]']);
/** More real (non-demo) accounts than this means the database is not a local playground. */
export const MAX_FOREIGN_USERS = 25;

/** Parses `KEY=VALUE` lines the way scripts/with-env.mjs does. */
export function parseEnvFile(text) {
  const env = {};
  for (const line of text.split(/\r?\n/)) {
    const match = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(line.trim());
    if (!match) continue;
    env[match[1]] = match[2].replace(/^(['"])(.*)\1$/, '$2');
  }
  return env;
}

/** `.env`, then `docker/local.env` (the compose order of the local run), then the shell. */
export function loadEnv(root, shell = process.env) {
  const files = ['.env', 'docker/local.env'].map((f) => path.join(root, f));
  const fromFiles = files
    .filter((f) => existsSync(f))
    .map((f) => parseEnvFile(readFileSync(f, 'utf8')));
  return Object.assign({}, ...fromFiles, shell);
}

/** The superuser of the local Postgres container: the seed bypasses the immutable-row triggers. */
export function databaseUrl(env) {
  if (env.DEMO_SEED_DATABASE_URL) return env.DEMO_SEED_DATABASE_URL;
  if (!env.POSTGRES_PASSWORD) {
    throw new Error(
      'POSTGRES_PASSWORD is empty: run "pnpm run env:init" and start the local stack',
    );
  }
  const port = env.POSTGRES_HOST_PORT || '5432';
  return `postgres://postgres:${encodeURIComponent(env.POSTGRES_PASSWORD)}@127.0.0.1:${port}/teamforge`;
}

const isLoopbackUrl = (value) => {
  try {
    return LOOPBACK_HOSTS.has(new URL(value).hostname);
  } catch {
    return false;
  }
};

/** Why the seed must not run here, or undefined. Checked before connecting. */
export function productionRefusal(env, url) {
  if (env.NODE_ENV === 'production') return 'NODE_ENV is production';
  if (!isLoopbackUrl(url)) return 'the database is not on localhost';
  for (const name of ['WEB_URL', 'APP_ORIGIN', 'BETTER_AUTH_URL']) {
    if (env[name] && !isLoopbackUrl(env[name])) return `${name} is not a localhost address`;
  }
  return undefined;
}
