import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  compareVersions,
  lockfileProblems,
  manifestProblems,
  releaseAgeProblems,
  splitPackageKey,
} from './check-deps.mjs';

test('check-deps: compares dotted versions numerically', () => {
  assert.equal(compareVersions('16.4.0', '15.2.3'), 1);
  assert.equal(compareVersions('4.2.67', '4.2.67'), 0);
  assert.equal(compareVersions('4.2.9', '4.2.67'), -1);
  assert.equal(compareVersions('1.1.21-beta.1', '1.1.21'), 0);
});

test('check-deps: splits scoped and plain lockfile keys', () => {
  assert.deepEqual(splitPackageKey('next@16.4.0'), { name: 'next', version: '16.4.0' });
  assert.deepEqual(splitPackageKey('@scope/pkg@1.2.3'), { name: '@scope/pkg', version: '1.2.3' });
});

test('check-deps: flags a vulnerable Next.js and accepts a fixed one', () => {
  assert.equal(lockfileProblems({ packages: { 'next@16.4.0': {}, 'react@19.3.0': {} } }).length, 0);
  const problems = lockfileProblems({ packages: { 'next@15.2.2': {}, 'pdfjs-dist@4.2.66': {} } });
  assert.equal(problems.length, 2);
  assert.match(problems[0], /CVE-2025-29927/);
});

test('check-deps: requires an exact packageManager and a single lockfile', () => {
  assert.deepEqual(manifestProblems({ packageManager: 'pnpm@12.11.2' }, []), []);
  assert.equal(manifestProblems({ packageManager: 'pnpm@^12' }, []).length, 1);
  assert.equal(manifestProblems({ packageManager: 'pnpm@12.11.2' }, ['yarn.lock']).length, 1);
});

test('check-deps: release-age policy needs minimumReleaseAge and documented exact exceptions', () => {
  const doc = '| `vitest@5.0.4` | 2026-10-12 | reason |';
  const ok = { minimumReleaseAge: 1440, minimumReleaseAgeExclude: ['vitest@5.0.4'] };
  assert.deepEqual(releaseAgeProblems(ok, doc), []);
  assert.match(releaseAgeProblems({ minimumReleaseAgeExclude: [] }, doc)[0], /minimumReleaseAge/);
  assert.match(
    releaseAgeProblems({ ...ok, minimumReleaseAgeExclude: ['vitest@^5.0.0'] }, doc)[0],
    /exact/,
  );
  assert.match(
    releaseAgeProblems({ ...ok, minimumReleaseAgeExclude: ['zod@4.6.7'] }, doc)[0],
    /not documented/,
  );
});
