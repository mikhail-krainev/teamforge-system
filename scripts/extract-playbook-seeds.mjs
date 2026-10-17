#!/usr/bin/env node
// Extracts the seed data of the playbooks module from docs/playbooks.md (S5-02):
//  - the YAML blocks of section 3.2 (web_service) and 4.3 (ml_product) -> apps/api/seeds/playbooks/*.yaml;
//  - the template catalog of section 5.1 (`--templates`), as JSON on stdout or into a file.
// The block text is copied byte for byte (plus one trailing newline), so the SHA-256 of a seed file is
// the SHA-256 that `playbooks:load` stores in `playbook.source_sha256`.
// Usage: node scripts/extract-playbook-seeds.mjs [--check] [--docs <playbooks.md>] [--out <dir>]
//        node scripts/extract-playbook-seeds.mjs --templates [<file>] [--docs <playbooks.md>]
// --check writes nothing: exit 1 when a seed file differs from the document (CI compares SHA-256).
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from 'yaml';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** Section heading prefix, product type and the sum of `duration_days` that the document promises. */
export const SEEDS = [
  { section: '### 3.2.', productType: 'web_service', totalDays: 84, file: 'web_service.yaml' },
  { section: '### 4.3.', productType: 'ml_product', totalDays: 91, file: 'ml_product.yaml' },
];

/** Text of the first ```yaml block that follows the heading starting with `section`. */
export function extractYamlBlock(markdown, section) {
  const lines = markdown.split(/\r?\n/);
  const start = lines.findIndex((line) => line.startsWith(section));
  if (start === -1) throw new Error(`section "${section}" not found`);
  const open = lines.findIndex((line, i) => i > start && /^```yaml\s*$/.test(line));
  if (open === -1) throw new Error(`section "${section}" has no yaml block`);
  const next = lines.findIndex((line, i) => i > start && /^#{1,3} /.test(line));
  if (next !== -1 && next < open) throw new Error(`section "${section}" has no yaml block`);
  const close = lines.findIndex((line, i) => i > open && /^```\s*$/.test(line));
  if (close === -1) throw new Error(`yaml block of "${section}" is not closed`);
  return `${lines.slice(open + 1, close).join('\n')}\n`;
}

/** Checks product type and total_days (document promise and the sum of the stages). */
export function checkSeed(text, seed) {
  const data = parse(text, { schema: 'core', maxAliasCount: 0 });
  const sum = data.stages.reduce((acc, stage) => acc + stage.duration_days, 0);
  const problems = [];
  if (data.product_type !== seed.productType) {
    problems.push(`product_type ${data.product_type}, expected ${seed.productType}`);
  }
  if (data.total_days !== seed.totalDays) {
    problems.push(`total_days ${data.total_days}, expected ${seed.totalDays}`);
  }
  if (sum !== data.total_days) problems.push(`stages sum to ${sum}, total_days ${data.total_days}`);
  return problems;
}

export function sha256(text) {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

/** Rows of the table in section 5.1: key, title, steps that use the template, section headings. */
export function extractTemplates(markdown) {
  const lines = markdown.split(/\r?\n/);
  const start = lines.findIndex((line) => line.startsWith('### 5.1.'));
  if (start === -1) throw new Error('section 5.1 not found');
  const templates = [];
  for (let i = start + 1; i < lines.length; i += 1) {
    const line = lines[i];
    if (line.startsWith('#')) break;
    const match = /^\| `(tpl_[a-z0-9_]+)` \| (.+?) \| (.+?) \| (.+) \|$/.exec(line);
    if (match === null) continue;
    const [, key, title, usedIn, headings] = match;
    templates.push({
      key,
      title,
      usedIn: usedIn.split(',').map((s) => s.trim()),
      headings: headings.split(';').map((s) => s.trim()),
    });
  }
  if (templates.length === 0) throw new Error('no templates in section 5.1');
  return templates;
}

/** Markdown body of a template: title and one empty section per heading. */
export function templateBody(template) {
  const sections = template.headings.map((h) => `## ${h}\n\n_Заполните раздел._\n`);
  return `# ${template.title}\n\n${sections.join('\n')}`;
}

function option(args, name) {
  const at = args.indexOf(name);
  return at === -1 ? undefined : args[at + 1];
}

function main(args) {
  const docs = path.resolve(option(args, '--docs') ?? path.join(root, 'docs/playbooks.md'));
  const markdown = readFileSync(docs, 'utf8');
  if (args.includes('--templates')) {
    const target = args[args.indexOf('--templates') + 1];
    const json = `${JSON.stringify(extractTemplates(markdown), null, 2)}\n`;
    if (target === undefined || target.startsWith('--')) process.stdout.write(json);
    else writeFileSync(target, json);
    return 0;
  }
  const check = args.includes('--check');
  const out = path.resolve(option(args, '--out') ?? path.join(root, 'apps/api/seeds/playbooks'));
  let failed = false;
  for (const seed of SEEDS) {
    const text = extractYamlBlock(markdown, seed.section);
    const problems = checkSeed(text, seed);
    if (problems.length > 0) {
      process.stderr.write(`${seed.file}: ${problems.join('; ')}\n`);
      failed = true;
      continue;
    }
    const target = path.join(out, seed.file);
    const digest = sha256(text);
    if (check) {
      const current = existsSync(target) ? readFileSync(target, 'utf8') : undefined;
      const same = current === text;
      if (!same) failed = true;
      process.stdout.write(
        `${seed.file} ${digest} ${same ? 'ok' : 'DIFFERS from docs/playbooks.md'}\n`,
      );
    } else {
      mkdirSync(out, { recursive: true });
      writeFileSync(target, text);
      process.stdout.write(`${seed.file} ${digest} total_days=${seed.totalDays}\n`);
    }
  }
  return failed ? 1 : 0;
}

if (
  process.argv[1] !== undefined &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  try {
    process.exit(main(process.argv.slice(2)));
  } catch (error) {
    process.stderr.write(
      `extract-playbook-seeds: ${error instanceof Error ? error.message : error}\n`,
    );
    process.exit(1);
  }
}
