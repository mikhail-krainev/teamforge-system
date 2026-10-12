#!/usr/bin/env node
// Supply-chain checks from docs/architecture.md 13.18 (SEC-19), run in CI after `pnpm install --frozen-lockfile`:
//  - exactly one lockfile (pnpm-lock.yaml) and an exact `packageManager` version;
//  - packages with a history of critical vulnerabilities must resolve to a fixed version;
//  - minimumReleaseAge is set and every release-age exception is exact and documented.
// Usage: node scripts/check-deps.mjs
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseAllDocuments, parseDocument } from 'yaml';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** Minimum resolved versions. Entries are checked as soon as the package appears in the lockfile. */
export const MINIMUM_VERSIONS = {
  next: { min: '15.2.3', why: 'CVE-2025-29927 (middleware authorization bypass)' },
  'pdfjs-dist': { min: '4.2.67', why: 'CVE-2024-4367 (arbitrary JS execution in PDF.js)' },
  'better-auth': { min: '1.1.21', why: 'CVE-2025-27143 (open redirect)' },
};

const FOREIGN_LOCKFILES = [
  'package-lock.json',
  'yarn.lock',
  'npm-shrinkwrap.json',
  'bun.lockb',
  'bun.lock',
];

/** Numeric comparison of dotted versions; pre-release suffixes are ignored. */
export function compareVersions(a, b) {
  const parts = (v) =>
    v
      .split('-')[0]
      .split('.')
      .map((n) => Number.parseInt(n, 10) || 0);
  const [pa, pb] = [parts(a), parts(b)];
  for (let i = 0; i < Math.max(pa.length, pb.length); i += 1) {
    const diff = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (diff !== 0) return Math.sign(diff);
  }
  return 0;
}

/** Package name and version from a lockfile key such as `@scope/name@1.2.3` or `next@16.4.0`. */
export function splitPackageKey(key) {
  const at = key.lastIndexOf('@');
  return at <= 0 ? null : { name: key.slice(0, at), version: key.slice(at + 1).split('(')[0] };
}

/** Problems found in a parsed lockfile: every resolved version of a watched package must be >= minimum. */
export function lockfileProblems(lock, minimums = MINIMUM_VERSIONS) {
  const problems = [];
  for (const key of Object.keys(lock.packages ?? {})) {
    const parsed = splitPackageKey(key);
    const rule = parsed && minimums[parsed.name];
    if (rule && compareVersions(parsed.version, rule.min) < 0) {
      problems.push(`${parsed.name}@${parsed.version} is below ${rule.min}: ${rule.why}`);
    }
  }
  return problems;
}

/** Smallest accepted `minimumReleaseAge` (minutes): the pnpm install gate must be set explicitly. */
export const MIN_RELEASE_AGE_MINUTES = 1440;

/**
 * Release-age policy (architecture 13.18, S1R-11): `minimumReleaseAge` is set in pnpm-workspace.yaml and every
 * `minimumReleaseAgeExclude` entry is an exact `name@x.y.z` that docs/security-exceptions.md names.
 */
export function releaseAgeProblems(workspace, exceptionsDoc) {
  const problems = [];
  const age = workspace?.minimumReleaseAge;
  if (!Number.isInteger(age) || age < MIN_RELEASE_AGE_MINUTES) {
    problems.push(
      `pnpm-workspace.yaml: minimumReleaseAge must be set to at least ${MIN_RELEASE_AGE_MINUTES} (minutes)`,
    );
  }
  for (const entry of workspace?.minimumReleaseAgeExclude ?? []) {
    if (!/^(@[^/@\s]+\/)?[^/@\s]+@\d+\.\d+\.\d+$/.test(entry)) {
      problems.push(`minimumReleaseAgeExclude: "${entry}" must be an exact name@x.y.z`);
    } else if (!exceptionsDoc.includes(`\`${entry}\``)) {
      problems.push(
        `minimumReleaseAgeExclude: ${entry} is not documented in docs/security-exceptions.md`,
      );
    }
  }
  return problems;
}

export function manifestProblems(manifest, existingFiles) {
  const problems = [];
  if (!/^pnpm@\d+\.\d+\.\d+$/.test(manifest.packageManager ?? '')) {
    problems.push('packageManager must pin an exact pnpm version (pnpm@x.y.z)');
  }
  for (const file of FOREIGN_LOCKFILES) {
    if (existingFiles.includes(file))
      problems.push(`${file} is forbidden: pnpm-lock.yaml is the only lockfile`);
  }
  return problems;
}

function main() {
  const manifest = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8'));
  // pnpm 12 writes a multi-document lockfile (environment + project); merge the `packages` of all documents.
  const documents = parseAllDocuments(readFileSync(path.join(root, 'pnpm-lock.yaml'), 'utf8'));
  const lock = {
    packages: Object.assign({}, ...documents.map((d) => d.toJS()?.packages ?? {})),
  };
  const present = FOREIGN_LOCKFILES.filter((f) => existsSync(path.join(root, f)));
  const workspace = parseDocument(
    readFileSync(path.join(root, 'pnpm-workspace.yaml'), 'utf8'),
  ).toJS();
  const exceptions = readFileSync(path.join(root, 'docs/security-exceptions.md'), 'utf8');
  const problems = [
    ...manifestProblems(manifest, present),
    ...lockfileProblems(lock),
    ...releaseAgeProblems(workspace, exceptions),
  ];
  if (problems.length > 0) {
    console.error(`Dependency policy violations:\n${problems.map((p) => `  - ${p}`).join('\n')}`);
    process.exit(1);
  }
  const watched = Object.keys(lock.packages ?? {})
    .map(splitPackageKey)
    .filter((p) => p && MINIMUM_VERSIONS[p.name])
    .map((p) => `${p.name}@${p.version}`);
  console.log(
    `Dependency policy OK. Watched packages in the lockfile: ${watched.join(', ') || 'none'}.`,
  );
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
