import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { GENERATORS, renderEnv } from './env-init.mjs';

const template = readFileSync(new URL('../.env.example', import.meta.url), 'utf8');

function parse(text) {
  return Object.fromEntries(
    text
      .split('\n')
      .filter((l) => /^[A-Z]/.test(l))
      .map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)]),
  );
}

test('env-init: fills secrets and URL passwords, keeps explicit values', () => {
  const env = parse(renderEnv(template));
  for (const name of Object.keys(GENERATORS)) assert.notEqual(env[name], '', name);
  assert.equal(
    env.DATABASE_URL,
    `postgres://tf_app:${env.TF_APP_PASSWORD}@localhost:6432/teamforge`,
  );
  assert.equal(
    env.DATABASE_DIRECT_URL,
    `postgres://tf_migrator:${env.TF_MIGRATOR_PASSWORD}@localhost:5432/teamforge`,
  );
  assert.equal(env.TRUSTED_PROXY_CIDRS, '', 'trust nobody by default');
  assert.equal(env.REDIS_URL, `redis://api:${env.REDIS_API_PASSWORD}@localhost:6379`);
  assert.equal(env.NODE_ENV, 'development');
  assert.equal(env.QUEUE_PREFIX, 'bull');
  assert.match(env.DATA_ENCRYPTION_KEY, /^[0-9a-f]{64}$/);
  assert.ok(env.BETTER_AUTH_SECRET.length >= 32);
});

test('env-init: every run produces different secrets', () => {
  assert.notEqual(
    parse(renderEnv(template)).BETTER_AUTH_SECRET,
    parse(renderEnv(template)).BETTER_AUTH_SECRET,
  );
});

test('env-init: template without empty secrets is unchanged', () => {
  assert.equal(renderEnv('A=1\nB=http://x\n'), 'A=1\nB=http://x\n');
});
