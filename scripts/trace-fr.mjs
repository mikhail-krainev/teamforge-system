#!/usr/bin/env node
// Traceability check (docs/plan.md, "Правила тестов"): every FR/CC/AF identifier that the plan assigns to a
// slice must appear in the title of at least one test (`it`, `test`, `describe`, `describeInfra`).
// Usage: pnpm run trace:fr [--slice N]   (default: 1)
import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PLAN = path.join(root, 'docs/plan.md');
const SKIPPED_DIRS = new Set(['node_modules', 'dist', '.next', 'coverage', '.git', 'docs']);
const TEST_FILE = /\.(test|spec)\.(ts|tsx|mjs|js)$/;

/** Text of the "Входящие FR" paragraph of one slice, from `## Срез N.` to the next `## `. */
export function incomingLine(plan, slice) {
  const start = plan.search(new RegExp(`^## Срез ${slice}\\.`, 'm'));
  if (start === -1) throw new Error(`Slice ${slice} not found in docs/plan.md`);
  const rest = plan.slice(start + 3);
  const next = rest.search(/^## /m);
  const section = next === -1 ? rest : rest.slice(0, next);
  const line = section.split('\n').find((l) => l.startsWith('**Входящие FR.**'));
  if (!line) throw new Error(`Slice ${slice} has no "Входящие FR" line`);
  return line;
}

/** Expands `FR-AUTH-01..04` into the individual identifiers. */
function expand(prefix, from, to) {
  const width = from.length;
  const ids = [];
  for (let n = Number(from); n <= Number(to ?? from); n += 1) {
    ids.push(`${prefix}-${String(n).padStart(width, '0')}`);
  }
  return ids;
}

/**
 * Identifiers owned by the slice. Text in parentheses and after "Операции" is explanatory
 * (it names other slices or operations) and is ignored.
 */
export function parseIncoming(line) {
  const text = line
    .replace(/\([^()]*\)/g, ' ')
    .split(/Операции/)[0]
    .replace(/`[^`]*`/g, ' ');
  const ids = new Set();
  for (const match of text.matchAll(/\b(FR-[A-Z]+|CC|AF)-(\d+)(?:\.\.(\d+))?/g)) {
    for (const id of expand(match[1], match[2], match[3])) ids.add(id);
  }
  return [...ids].sort();
}

/** All test titles (string literals of the first argument) found in a source text. */
export function testTitles(source) {
  const titles = [];
  const call =
    /\b(?:it|test|describe|describeInfra)(?:\.\w+)*\(\s*(['"`])((?:\\.|(?!\1)[^\\])*)\1/g;
  for (const match of source.matchAll(call)) titles.push(match[2]);
  const step = /\btest\.step\(\s*(['"`])((?:\\.|(?!\1)[^\\])*)\1/g;
  for (const match of source.matchAll(step)) titles.push(match[2]);
  return titles;
}

function* walk(dir) {
  for (const entry of readdirSync(dir)) {
    if (SKIPPED_DIRS.has(entry)) continue;
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) yield* walk(full);
    else if (TEST_FILE.test(entry)) yield full;
  }
}

/** Map identifier -> files whose test titles mention it. */
export function collectCoverage(ids, files) {
  const coverage = new Map(ids.map((id) => [id, []]));
  for (const file of files) {
    const titles = testTitles(readFileSync(file, 'utf8')).join('\n');
    for (const id of ids) {
      if (new RegExp(`\\b${id}\\b`).test(titles)) coverage.get(id).push(path.relative(root, file));
    }
  }
  return coverage;
}

function main() {
  const sliceAt = process.argv.indexOf('--slice');
  const slice = sliceAt === -1 ? 1 : Number(process.argv[sliceAt + 1]);
  const ids = parseIncoming(incomingLine(readFileSync(PLAN, 'utf8'), slice));
  // Product tests only: tests of the repository scripts mention identifiers as sample data.
  const files = [...walk(path.join(root, 'apps')), ...walk(path.join(root, 'packages'))];
  const coverage = collectCoverage(ids, files);
  const missing = [];
  for (const [id, where] of coverage) {
    console.log(
      `${where.length > 0 ? 'ok     ' : 'MISSING'} ${id}${where.length > 0 ? `  <- ${where.join(', ')}` : ''}`,
    );
    if (where.length === 0) missing.push(id);
  }
  console.log(
    `\nslice ${slice}: ${ids.length - missing.length}/${ids.length} identifiers traced to tests`,
  );
  if (missing.length > 0) process.exit(1);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
