import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';

const script = resolve(import.meta.dirname, '../../../scripts/gen-module.mjs');
const root = mkdtempSync(join(tmpdir(), 'tf-gen-module-'));

function generate(name: string) {
  return spawnSync(process.execPath, [script, name, '--root', root], { encoding: 'utf8' });
}

describe('S1-11 gen-module', () => {
  afterAll(() => rmSync(root, { recursive: true, force: true }));

  it('creates the module skeleton from the plan structure', () => {
    const result = generate('sample');
    expect(result.status).toBe(0);
    for (const file of [
      'public.ts',
      'sample.module.ts',
      'internal/controllers/.gitkeep',
      'internal/services/.gitkeep',
      'internal/repositories/.gitkeep',
      'internal/schema/.gitkeep',
      'internal/events/.gitkeep',
      'internal/jobs/.gitkeep',
      'internal/domain/.gitkeep',
      'test/.gitkeep',
    ]) {
      expect(existsSync(join(root, 'sample', file)), file).toBe(true);
    }
    expect(readFileSync(join(root, 'sample', 'sample.module.ts'), 'utf8')).toContain(
      'export class SampleModule',
    );
  });

  it('refuses an existing module and invalid names', () => {
    expect(generate('sample').status).toBe(1);
    expect(generate('Bad-Name').status).toBe(1);
  });
});
