#!/usr/bin/env node
// Contract gate (docs/architecture.md 13.14, 14): operationId uniqueness, x-fr, x-authz
// (actor, chain) and Idempotency-Key on mutating operations.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { parse } from 'yaml';

const HTTP_METHODS = ['get', 'put', 'post', 'delete', 'options', 'head', 'patch'];
const SAFE_METHODS = new Set(['get', 'head', 'options']);
const ACTORS = new Set([
  'public',
  'github-signature',
  'authenticated',
  'self',
  'team-member',
  'team-participant',
  'team-lead',
  'offer-party',
  'invitee',
  'vote-participant',
  'admin',
]);
// Actors for which a top-level resource id may stay out of `chain` (no parent to own it).
const TOP_LEVEL_ACTORS = new Set(['public', 'github-signature', 'authenticated', 'admin']);
const NO_FR = new Set(['healthLive', 'healthReady']);
// Mutating operations without Idempotency-Key (architecture 14): Better Auth routes (/auth/*),
// GitHub webhook (idempotent by X-GitHub-Delivery), GitHub setup callback, safe preview,
// token-idempotent deletion cancel.
const IDEMPOTENCY_EXEMPT = new Set([
  'receiveGithubWebhook',
  'githubSetupCallback',
  'previewInvitation',
  'cancelDeletionRequest',
]);
const IDEMPOTENCY_REF = '#/components/parameters/IdempotencyKey';

export function listOperations(doc) {
  const ops = [];
  for (const [route, item] of Object.entries(doc.paths ?? {})) {
    for (const method of HTTP_METHODS) {
      if (item?.[method]) ops.push({ route, method, op: item[method], item });
    }
  }
  return ops;
}

function pathParams(route) {
  return [...route.matchAll(/\{([^}]+)\}/g)].map((m) => m[1]);
}

function hasIdempotencyKey(doc, { op, item }) {
  const params = [...(item.parameters ?? []), ...(op.parameters ?? [])];
  return params.some((p) => {
    if (p.$ref === IDEMPOTENCY_REF) return true;
    const resolved = p.$ref ? doc.components?.parameters?.[p.$ref.split('/').pop()] : p;
    return resolved?.in === 'header' && resolved?.name === 'Idempotency-Key';
  });
}

function checkAuthz(entry, id) {
  const { route, op } = entry;
  const errors = [];
  const authz = op['x-authz'];
  if (!authz || typeof authz !== 'object') return [`${id}: missing x-authz`];
  if (!ACTORS.has(authz.actor)) errors.push(`${id}: x-authz.actor invalid: ${authz.actor}`);
  const chain = Array.isArray(authz.chain) ? authz.chain : [];
  if (authz.chain !== undefined && !Array.isArray(authz.chain)) {
    errors.push(`${id}: x-authz.chain must be an array`);
  }
  const params = pathParams(route);
  params.forEach((param, index) => {
    if (chain.includes(param)) return;
    const topLevel = index === 0 && TOP_LEVEL_ACTORS.has(authz.actor);
    if (!topLevel) errors.push(`${id}: path id "${param}" missing from x-authz.chain`);
  });
  for (const link of chain) {
    if (!params.includes(link)) errors.push(`${id}: chain entry "${link}" is not a path id`);
  }
  return errors;
}

function checkOperation(doc, entry) {
  const { route, method, op } = entry;
  const id = op.operationId ?? `${method.toUpperCase()} ${route}`;
  const errors = [];
  if (!op.operationId) errors.push(`${id}: missing operationId`);
  if (!NO_FR.has(op.operationId) && !(Array.isArray(op['x-fr']) && op['x-fr'].length > 0)) {
    errors.push(`${id}: missing x-fr`);
  }
  errors.push(...checkAuthz(entry, id));
  const exempt = route.startsWith('/auth/') || IDEMPOTENCY_EXEMPT.has(op.operationId);
  if (!SAFE_METHODS.has(method) && !exempt && !hasIdempotencyKey(doc, entry)) {
    errors.push(`${id}: mutating operation without Idempotency-Key`);
  }
  return errors;
}

export function checkContract(doc) {
  const entries = listOperations(doc);
  const errors = [];
  const seen = new Set();
  for (const entry of entries) {
    const id = entry.op.operationId;
    if (id && seen.has(id)) errors.push(`${id}: duplicate operationId`);
    if (id) seen.add(id);
    errors.push(...checkOperation(doc, entry));
  }
  return { operations: entries.length, errors };
}

function main() {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const file = process.argv[2] ?? path.join(root, 'docs/api/openapi.yaml');
  const { operations, errors } = checkContract(parse(readFileSync(file, 'utf8')));
  if (errors.length > 0) {
    console.error(`Contract check failed (${errors.length} problems):`);
    for (const e of errors) console.error(`  - ${e}`);
    process.exit(1);
  }
  console.log(
    `Contract OK: ${operations} operations, all with x-fr/x-authz/Idempotency-Key rules.`,
  );
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
