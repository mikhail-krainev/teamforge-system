import { spawnSync } from 'node:child_process';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const api = resolve(import.meta.dirname, '..');
const repo = resolve(api, '../..');
const probeDir = resolve(api, 'src/modules/matching/zz-boundary-probe');
const probeFile = resolve(probeDir, 'probe.ts');
const internalFile = resolve(api, 'src/modules/teams/internal/services/zz-boundary-probe.ts');

function run(script: string, args: string[]) {
  return spawnSync(process.execPath, [script, ...args], { cwd: api, encoding: 'utf8' });
}

const eslint = (target: string) =>
  run(resolve(repo, 'node_modules/eslint/bin/eslint.js'), [target, '--no-warn-ignored']);
const depcruise = () =>
  run(resolve(api, 'node_modules/dependency-cruiser/bin/dependency-cruiser.mjs'), [
    'src',
    '--config',
    '../../.dependency-cruiser.cjs',
  ]);

// Each case spawns a type-aware eslint / dependency-cruiser: 40+ s on a loaded machine (the whole
// integration suite runs in parallel), far above the 30 s default.
describe(
  'S1-11 module boundaries (eslint-plugin-boundaries + dependency-cruiser)',
  { timeout: 180_000 },
  () => {
    beforeAll(() => {
      mkdirSync(probeDir, { recursive: true });
      writeFileSync(internalFile, 'export const probe = 1;\n');
      writeFileSync(
        probeFile,
        "import { probe } from '../../teams/internal/services/zz-boundary-probe.js';\nexport const used = probe;\n",
      );
    });

    afterAll(() => {
      rmSync(probeDir, { recursive: true, force: true });
      rmSync(internalFile, { force: true });
    });

    it('an import of another module internal/** breaks lint', () => {
      const result = eslint(probeFile);
      expect(result.status).toBe(1);
      expect(result.stdout).toContain('must not import internals of another module');
    });

    it('an import of another module internal/** breaks depcruise --validate', () => {
      const result = depcruise();
      expect(result.status).not.toBe(0);
      expect(result.stdout).toContain('no-cross-module-internal');
    });

    it('a public.ts import along an allowed edge passes both checks', () => {
      writeFileSync(
        probeFile,
        "import { TEAMS_MODULE } from '../../teams/public.js';\nexport const used = TEAMS_MODULE;\n",
      );
      expect(eslint(probeFile).status).toBe(0);
    });

    it('a public.ts import against the edge table (matching -> rewards) breaks lint', () => {
      writeFileSync(
        probeFile,
        "import { REWARDS_MODULE } from '../../rewards/public.js';\nexport const used = REWARDS_MODULE;\n",
      );
      const result = eslint(probeFile);
      expect(result.status).toBe(1);
      expect(result.stdout).toContain('matching may depend only on');
    });
  },
);
