// Fails when the Drizzle schema differs from the committed migrations: `drizzle-kit generate`
// must not create new files. Offline: no database connection needed.
import { spawnSync } from 'node:child_process';
import { readdirSync, rmSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const out = resolve(root, 'drizzle');
const meta = resolve(out, 'meta');
const listing = () => [...readdirSync(out), ...readdirSync(meta).map((f) => `meta/${f}`)].sort();
const journalPath = resolve(meta, '_journal.json');

const before = listing();
const journalBefore = readFileSync(journalPath, 'utf8');
const kitBin = resolve(root, 'node_modules/drizzle-kit/bin.cjs');
const run = spawnSync(process.execPath, [kitBin, 'generate', '--name', 'check_tmp'], {
  cwd: root,
  encoding: 'utf8',
});
const after = listing();
const created = after.filter((f) => !before.includes(f));
for (const file of created) rmSync(resolve(out, file), { force: true });
writeFileSync(journalPath, journalBefore);

if (run.status !== 0) {
  process.stderr.write(`drizzle-kit generate failed:\n${run.stdout}\n${run.stderr}\n`);
  process.exit(1);
}
if (created.length > 0) {
  process.stderr.write(
    `Schema differs from migrations. Run "pnpm --filter api db:generate".\nNew: ${created.join(', ')}\n`,
  );
  process.exit(1);
}
process.stdout.write('Drizzle schema matches committed migrations.\n');
