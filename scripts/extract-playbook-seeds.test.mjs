import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  SEEDS,
  checkSeed,
  extractTemplates,
  extractYamlBlock,
  sha256,
  templateBody,
} from './extract-playbook-seeds.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const markdown = readFileSync(path.join(root, 'docs/playbooks.md'), 'utf8');

test('the YAML blocks of 3.2 and 4.3 are extracted with total_days 84 and 91', () => {
  for (const seed of SEEDS) {
    const text = extractYamlBlock(markdown, seed.section);
    assert.deepEqual(checkSeed(text, seed), [], seed.file);
  }
  assert.deepEqual(
    SEEDS.map((seed) => seed.totalDays),
    [84, 91],
  );
});

test('the committed seed files are byte for byte the blocks of docs/playbooks.md (CI compares SHA-256)', () => {
  for (const seed of SEEDS) {
    const expected = extractYamlBlock(markdown, seed.section);
    const committed = readFileSync(path.join(root, 'apps/api/seeds/playbooks', seed.file), 'utf8');
    assert.equal(
      sha256(committed),
      sha256(expected),
      `${seed.file} differs: run extract-playbook-seeds.mjs`,
    );
  }
});

test('checkSeed reports a wrong product type and a wrong sum', () => {
  const text = 'product_type: x\ntotal_days: 10\nstages:\n  - duration_days: 3\n';
  assert.equal(checkSeed(text, { productType: 'y', totalDays: 10 }).length, 2);
});

test('a missing or empty section is an error', () => {
  assert.throws(() => extractYamlBlock('# nothing', '### 3.2.'), /not found/);
  assert.throws(
    () => extractYamlBlock('### 3.2. X\n\ntext\n\n## 4. Next\n```yaml\na: 1\n```\n', '### 3.2.'),
    /no yaml block/,
  );
});

test('the template catalog of 5.1 has 35 templates; the migration seeds the same keys and titles', () => {
  const templates = extractTemplates(markdown);
  assert.equal(templates.length, 35);
  const sql = readFileSync(
    path.join(root, 'apps/api/drizzle/0010_seed_platform_templates.sql'),
    'utf8',
  );
  for (const template of templates) {
    assert.ok(
      sql.includes(
        `$k$${template.key}$k$, 1, $t$${template.title}$t$, $b$${templateBody(template)}$b$`,
      ),
      template.key,
    );
  }
  assert.equal((sql.match(/\$k\$tpl_/g) ?? []).length, 35);
});
