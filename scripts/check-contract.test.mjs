import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { parse } from 'yaml';
import { checkContract } from './check-contract.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const load = () => parse(readFileSync(path.join(root, 'docs/api/openapi.yaml'), 'utf8'));
const find = (doc, id) => {
  for (const item of Object.values(doc.paths)) {
    for (const o of Object.values(item)) if (o?.operationId === id) return o;
  }
  throw new Error(`no operation ${id}`);
};
const hasError = (doc, prefix, text) =>
  checkContract(doc).errors.some((e) => e.startsWith(prefix) && e.includes(text));

test('real contract passes with 114 operations', () => {
  const result = checkContract(load());
  assert.deepEqual(result.errors, []);
  assert.equal(result.operations, 114);
});

test('duplicate operationId fails', () => {
  const doc = load();
  find(doc, 'listRoles').operationId = 'getMe';
  assert.ok(hasError(doc, 'getMe', 'duplicate operationId'));
});

test('missing x-fr fails', () => {
  const doc = load();
  delete find(doc, 'getMe')['x-fr'];
  assert.ok(hasError(doc, 'getMe', 'x-fr'));
});

test('missing x-authz fails', () => {
  const doc = load();
  delete find(doc, 'getMe')['x-authz'];
  assert.ok(hasError(doc, 'getMe', 'x-authz'));
});

test('invalid actor fails', () => {
  const doc = load();
  find(doc, 'getMe')['x-authz'].actor = 'root';
  assert.ok(hasError(doc, 'getMe', 'actor invalid'));
});

test('nested id missing from chain fails', () => {
  const doc = load();
  find(doc, 'updateSeat')['x-authz'].chain = ['teamId'];
  assert.ok(hasError(doc, 'updateSeat', '"seatId" missing'));
});

test('mutating operation without Idempotency-Key fails', () => {
  const doc = load();
  const op = find(doc, 'createTeam');
  op.parameters = op.parameters.filter((p) => !String(p.$ref).endsWith('IdempotencyKey'));
  assert.ok(hasError(doc, 'createTeam', 'Idempotency-Key'));
});

test('CLI exits 0 on the real contract and 1 on a broken file', () => {
  const script = path.join(root, 'scripts/check-contract.mjs');
  const ok = spawnSync(process.execPath, [script], { encoding: 'utf8' });
  assert.equal(ok.status, 0, ok.stderr);
  assert.match(ok.stdout, /114 operations/);
  const broken = path.join(root, 'scripts/fixtures/broken.yaml');
  const bad = spawnSync(process.execPath, [script, broken], { encoding: 'utf8' });
  assert.equal(bad.status, 1);
  assert.match(bad.stderr, /missing x-authz/);
});
