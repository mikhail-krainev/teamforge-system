#!/usr/bin/env node
// Breaking-change check of the contract against a base ref via oasdiff (runs in Docker).
// Usage: pnpm run contract:breaking [baseRef=origin/main]
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const baseRef = process.argv[2] ?? 'origin/main';
const CONTRACT = 'docs/api/openapi.yaml';
// Pinned by digest (architecture 13.18). The official ghcr.io image needs a login, Docker Hub does not.
const OASDIFF_IMAGE =
  'tufin/oasdiff@sha256:2e32b0c600523a308f338a7d8456603f6caf47d9bbcdbd1fb366c21d80e42c5f';

function run(cmd, args, options = {}) {
  const res = spawnSync(cmd, args, { cwd: root, encoding: 'utf8', ...options });
  if (res.error) throw res.error;
  return res;
}

const show = run('git', ['show', `${baseRef}:${CONTRACT}`], { maxBuffer: 64 * 1024 * 1024 });
if (show.status !== 0) {
  console.error(`Cannot read ${CONTRACT} from ${baseRef}: ${show.stderr}`);
  process.exit(2);
}
const dir = mkdtempSync(path.join(tmpdir(), 'oasdiff-'));
writeFileSync(path.join(dir, 'base.yaml'), show.stdout);

const docker = run(
  'docker',
  [
    'run',
    '--rm',
    '-v',
    `${dir}:/base:ro`,
    '-v',
    `${path.join(root, 'docs/api')}:/head:ro`,
    OASDIFF_IMAGE,
    'breaking',
    '/base/base.yaml',
    '/head/openapi.yaml',
    '--fail-on',
    'ERR',
  ],
  { stdio: 'inherit' },
);
process.exit(docker.status ?? 1);
