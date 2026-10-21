#!/usr/bin/env node
// Generates `.env` from `.env.example` with random development secrets. Never overwrites an existing `.env`.
// Usage: pnpm run env:init
import { generateKeyPairSync, randomBytes } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const hex = (bytes) => randomBytes(bytes).toString('hex');

/**
 * A throwaway RSA key on one line (`\n` escapes): an `.env` file holds no line breaks. It only lets the api
 * start without a GitHub App (S6-03 validates the key at startup); replace the four GITHUB_APP_* values with
 * the real App to install it on repositories.
 */
function developmentAppKey() {
  const { privateKey } = generateKeyPairSync('rsa', {
    modulusLength: 2048,
    privateKeyEncoding: { type: 'pkcs1', format: 'pem' },
    publicKeyEncoding: { type: 'spki', format: 'pem' },
  });
  return privateKey.trim().replaceAll('\n', '\\n');
}

/** Variables that get a random value when empty in the template. */
export const GENERATORS = {
  BETTER_AUTH_SECRET: () => randomBytes(32).toString('base64url'),
  IP_HASH_SALT: () => randomBytes(32).toString('base64url'),
  DATA_ENCRYPTION_KEY: () => hex(32),
  GITHUB_WEBHOOK_SECRET: () => hex(24),
  GITHUB_APP_ID: () => '1',
  GITHUB_APP_SLUG: () => 'teamforge-dev',
  GITHUB_APP_PRIVATE_KEY: developmentAppKey,
  POSTGRES_PASSWORD: () => hex(16),
  TF_MIGRATOR_PASSWORD: () => hex(16),
  TF_APP_PASSWORD: () => hex(16),
  REDIS_API_PASSWORD: () => hex(16),
  REDIS_WORKER_PASSWORD: () => hex(16),
  REDIS_LINKCHECK_PASSWORD: () => hex(16),
  REDIS_RESUME_PRODUCER_PASSWORD: () => hex(16),
  REDIS_RESUME_PASSWORD: () => hex(16),
  S3_ACCESS_KEY: () => `tf${hex(8)}`,
  S3_SECRET_KEY: () => hex(20),
};

/** Which generated password belongs to the user part of a `scheme://user:@host` URL. */
export const URL_PASSWORDS = {
  tf_migrator: 'TF_MIGRATOR_PASSWORD',
  tf_app: 'TF_APP_PASSWORD',
  api: 'REDIS_API_PASSWORD',
  worker: 'REDIS_WORKER_PASSWORD',
  linkcheck: 'REDIS_LINKCHECK_PASSWORD',
  resume_producer: 'REDIS_RESUME_PRODUCER_PASSWORD',
  resume: 'REDIS_RESUME_PASSWORD',
};

const LINE = /^([A-Z][A-Z0-9_]*)=(.*)$/;
const EMPTY_PASSWORD_URL = /^([a-z]+:\/\/)([A-Za-z0-9_]+):@(.*)$/;

/**
 * Renders the `.env` text from the template text. Pure: randomness comes from `generators`.
 * Only empty values are filled; values already present in the template are kept.
 */
export function renderEnv(template, generators = GENERATORS) {
  const generated = {};
  const lines = template.split(/\r?\n/);
  for (const line of lines) {
    const match = LINE.exec(line);
    if (match && match[2] === '' && generators[match[1]])
      generated[match[1]] = generators[match[1]]();
  }
  return lines
    .map((line) => {
      const match = LINE.exec(line);
      if (!match) return line;
      const [, name, value] = match;
      if (value === '' && generated[name] !== undefined) return `${name}=${generated[name]}`;
      const url = EMPTY_PASSWORD_URL.exec(value);
      const source = url ? URL_PASSWORDS[url[2]] : undefined;
      if (url && source && generated[source] !== undefined) {
        return `${name}=${url[1]}${url[2]}:${generated[source]}@${url[3]}`;
      }
      return line;
    })
    .join('\n');
}

function main() {
  const target = path.join(root, '.env');
  if (existsSync(target)) {
    console.log('.env already exists: left untouched (delete it to regenerate).');
    return;
  }
  const template = readFileSync(path.join(root, '.env.example'), 'utf8');
  writeFileSync(target, renderEnv(template), { mode: 0o600 });
  console.log('.env created with random development secrets.');
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
