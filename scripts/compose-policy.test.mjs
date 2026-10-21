// Security policy of the compose files (S1R-10, S1R-12): the application never connects to PostgreSQL as a
// superuser, migrations use their own owner role, and X-Forwarded-For is trusted from the web container only.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { parse } from 'yaml';

const read = (name) => readFileSync(new URL(`../${name}`, import.meta.url), 'utf8');
const dev = parse(read('docker-compose.yml'));
const testStack = parse(read('docker-compose.test.yml'));
const appEnv = dev['x-app-env'];

const userOf = (url) => new URL(url.replace(/\$\{[^}]*\}/g, 'x')).username;

test('compose: api and worker connect as tf_app, never as the superuser', () => {
  assert.equal(userOf(appEnv.DATABASE_URL), 'tf_app');
  for (const service of ['api', 'worker']) {
    const environment = dev.services[service].environment;
    assert.equal(userOf(environment.DATABASE_URL ?? appEnv.DATABASE_URL), 'tf_app', service);
  }
  assert.equal(userOf(dev.services.pgbouncer.environment.DATABASE_URL), 'tf_app');
  assert.equal(userOf(testStack.services.pgbouncer.environment.DATABASE_URL), 'tf_app');
});

test('compose: only the migrate job uses the owner role, over the direct connection', () => {
  const direct = dev.services.migrate.environment.DATABASE_DIRECT_URL;
  assert.equal(userOf(direct), 'tf_migrator');
  assert.match(direct, /@postgres:5432\//, 'direct connection, not through PgBouncer');
  const others = Object.entries(dev.services).filter(([name]) => name !== 'migrate');
  for (const [name, service] of others) {
    assert.ok(!JSON.stringify(service.environment ?? {}).includes('tf_migrator'), name);
  }
});

test('compose: the superuser has its own name and PgBouncer has no admin console user', () => {
  for (const stack of [dev, testStack]) {
    assert.equal(stack.services.postgres.environment.POSTGRES_USER, 'postgres');
    assert.ok(!('ADMIN_USERS' in stack.services.pgbouncer.environment));
    assert.ok(
      stack.services.postgres.volumes.some((v) => v.includes('/docker-entrypoint-initdb.d')),
      'role init script is mounted',
    );
  }
});

test('compose: the role init script creates tf_app without superuser, createdb or createrole', () => {
  const script = read('docker/postgres/10-roles.sh');
  assert.match(script, /CREATE ROLE tf_app LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE/);
  assert.match(script, /ALTER DATABASE :"db" OWNER TO tf_migrator/);
  assert.match(
    script,
    /DEFAULT PRIVILEGES FOR ROLE tf_migrator GRANT SELECT, INSERT, UPDATE, DELETE/,
  );
  const statement = /CREATE ROLE tf_app[^;]*;/.exec(script)[0];
  assert.doesNotMatch(statement, /(?<!NO)(SUPERUSER|CREATEDB|CREATEROLE|BYPASSRLS|REPLICATION)/);
});

test('compose: only the web container is trusted for X-Forwarded-For, by default', () => {
  const fallback = appEnv.TRUSTED_PROXY_CIDRS;
  assert.match(fallback, /^\$\{TRUSTED_PROXY_CIDRS:-\$\{TF_WEB_IP:-[\d.]+\}\/32\}$/);
  const defaultWebIp = /TF_WEB_IP:-([\d.]+)\}/.exec(fallback)[1];
  assert.equal(dev.services.web.networks.default.ipv4_address, `\${TF_WEB_IP:-${defaultWebIp}}`);
  const subnet = dev.networks.default.ipam.config[0].subnet;
  assert.match(subnet, /^\$\{TF_NET_SUBNET:-[\d.]+\/(2[4-9]|30)\}$/, 'an explicit narrow subnet');
  const prefix = /TF_NET_SUBNET:-(\d+\.\d+\.\d+)\./.exec(subnet)[1];
  assert.ok(defaultWebIp.startsWith(`${prefix}.`), 'web address lies in the subnet');
  assert.doesNotMatch(read('docker-compose.yml'), /172\.16\.0\.0\/12/);
});

test('env template: no proxy is trusted by default', () => {
  assert.match(read('.env.example'), /^TRUSTED_PROXY_CIDRS=$/m);
});

test('compose: every service that calls GitHub maps host.docker.internal (the e2e double on a Linux host)', () => {
  assert.ok(
    'GITHUB_API_BASE_URL' in appEnv,
    'the GitHub base URL is part of the shared environment',
  );
  for (const service of ['api', 'worker']) {
    assert.ok(
      dev.services[service].extra_hosts?.includes('host.docker.internal:host-gateway'),
      `${service} resolves host.docker.internal also without Docker Desktop`,
    );
  }
});
