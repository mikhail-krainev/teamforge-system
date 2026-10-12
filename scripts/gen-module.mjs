// Scaffolds a NestJS module skeleton (docs/plan.md, "Структура модуля NestJS").
// Usage: node scripts/gen-module.mjs <name> [--root <modules-dir>]
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const DEFAULT_ROOT = resolve(here, '../apps/api/src/modules');
const NAME_PATTERN = /^[a-z][a-z0-9]*$/;
const INTERNAL_DIRS = [
  'controllers',
  'services',
  'repositories',
  'schema',
  'events',
  'jobs',
  'domain',
];

/** @param {string} name */
function pascal(name) {
  return name.charAt(0).toUpperCase() + name.slice(1);
}

/** @param {string} name */
export function publicTemplate(name) {
  return `/**
 * Public surface of the ${name} module (ADR-0001): the only file other modules may import.
 * Add here: the facade interface ${pascal(name)}Api, its DTOs, event types and port tokens.
 */
export const ${name.toUpperCase()}_MODULE = '${name}' as const;
`;
}

/** @param {string} name */
export function moduleTemplate(name) {
  return `import { Module } from '@nestjs/common';

/** ${pascal(name)} module. Providers and controllers are registered by the module's tasks. */
@Module({})
export class ${pascal(name)}Module {}
`;
}

/**
 * Creates modules/<name>/{public.ts,<name>.module.ts,internal/*,test/}.
 * @param {string} name
 * @param {string} [root]
 * @returns {string[]} created file paths
 */
export function generateModule(name, root = DEFAULT_ROOT) {
  if (!NAME_PATTERN.test(name)) {
    throw new Error(`Invalid module name "${name}": use lowercase letters and digits only`);
  }
  const base = join(root, name);
  if (existsSync(base)) throw new Error(`Module "${name}" already exists at ${base}`);
  const files = [
    [join(base, 'public.ts'), publicTemplate(name)],
    [join(base, `${name}.module.ts`), moduleTemplate(name)],
    ...INTERNAL_DIRS.map((dir) => [join(base, 'internal', dir, '.gitkeep'), '']),
    [join(base, 'test', '.gitkeep'), ''],
  ];
  for (const [file, content] of files) {
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, content);
  }
  return files.map(([file]) => file);
}

function main(argv) {
  const rootIndex = argv.indexOf('--root');
  const root = rootIndex >= 0 ? resolve(argv[rootIndex + 1] ?? '') : DEFAULT_ROOT;
  const name = argv.find((arg, i) => !arg.startsWith('--') && argv[i - 1] !== '--root');
  if (name === undefined) {
    process.stderr.write('Usage: gen-module <name> [--root <modules-dir>]\n');
    process.exit(1);
  }
  try {
    const created = generateModule(name, root);
    process.stdout.write(`Created ${created.length} files for module "${name}".\n`);
    process.stdout.write(
      [
        'Next steps (shared files are edited by the orchestrator):',
        `  - register ${pascal(name)}Module in apps/api/src/app.module.ts`,
        `  - add "${name}" and its allowed edges to MODULE_EDGES in .dependency-cruiser.cjs`,
        `    and to the same table in eslint.config.js (architecture 2.2)`,
        '',
      ].join('\n'),
    );
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(1);
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2));
}
