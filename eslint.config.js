import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import globals from 'globals';
import prettier from 'eslint-config-prettier';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';

// eslint-plugin-boundaries is an apps/api dev dependency (S1-11); resolve it from there.
const root = fileURLToPath(new URL('.', import.meta.url));
const apiRequire = createRequire(new URL('./apps/api/package.json', import.meta.url));
const boundaries = (
  await import(pathToFileURL(apiRequire.resolve('eslint-plugin-boundaries')).href)
).default;
const { MODULE_EDGES } = createRequire(import.meta.url)('./.dependency-cruiser.cjs');

// Module boundaries (architecture 2.1-2.2): a module imports another only via its public.ts and
// only along the allowed edges. Policies are generated from MODULE_EDGES (same table as depcruise).
// Elements are folders: each modules/<m> folder is one element carrying the captured module name.
const boundaryPolicies = Object.entries(MODULE_EDGES).flatMap(([name, allowed]) => {
  const from = { element: { type: 'module', captured: { module: name } } };
  return [
    {
      from,
      disallow: {
        to: {
          element: { type: 'module', captured: { module: `!(${[name, ...allowed].join('|')})` } },
        },
      },
      message: `${name} may depend only on: ${allowed.join(', ') || 'nothing'} (architecture 2.2)`,
    },
    {
      from,
      disallow: {
        to: {
          element: { type: 'module', captured: { module: `!${name}` } },
          file: { path: '!**/modules/*/public.ts' },
        },
      },
      message: `${name} must not import internals of another module; import its public.ts`,
    },
  ];
});

const boundariesConfig = {
  files: ['apps/api/src/**/*.ts'],
  plugins: { boundaries },
  settings: {
    'import/resolver': {
      [fileURLToPath(new URL('./apps/api/eslint-resolver.cjs', import.meta.url))]: {},
    },
    'boundaries/root-path': root,
    'boundaries/elements': [
      { type: 'module', pattern: 'apps/api/src/modules/*', capture: ['module'] },
      { type: 'platform', pattern: 'apps/api/src/platform' },
    ],
  },
  rules: {
    'boundaries/dependencies': [
      'error',
      {
        default: 'allow',
        policies: [
          ...boundaryPolicies,
          {
            from: { element: { type: 'platform' } },
            disallow: { to: { element: { type: 'module' } } },
            message: 'The platform layer must not import domain modules',
          },
        ],
      },
    ],
  },
};

export default tseslint.config(
  {
    ignores: [
      '**/node_modules/**',
      '**/dist/**',
      '**/.next/**',
      '**/coverage/**',
      'packages/shared/src/generated/**',
      'packages/shared/openapi.json',
      'docs/**',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    languageOptions: { globals: { ...globals.node } },
    rules: {
      'no-console': 'error',
      'max-lines': ['error', { max: 800, skipBlankLines: true, skipComments: true }],
      'max-lines-per-function': ['error', { max: 50, skipBlankLines: true, skipComments: true }],
      'max-depth': ['error', 4],
    },
  },
  boundariesConfig,
  {
    files: ['**/*.cjs'],
    rules: { '@typescript-eslint/no-require-imports': 'off' },
  },
  {
    files: ['scripts/**/*.mjs'],
    rules: { 'no-console': 'off' },
  },
  {
    // Load-test preparation and k6 scenarios (docs/release.md, section 5): command-line tools.
    files: ['scripts/load/**/*.{js,mjs}'],
    rules: { 'no-console': 'off', 'max-lines-per-function': 'off' },
  },
  {
    // k6 scenarios run in the k6 runtime, which provides these globals instead of Node.
    files: ['scripts/load/**/*.js'],
    languageOptions: {
      globals: { __ENV: 'readonly', __VU: 'readonly', __ITER: 'readonly', open: 'readonly' },
    },
  },
  {
    files: ['**/*.test.*'],
    rules: { 'max-lines-per-function': 'off' },
  },
  prettier,
);
