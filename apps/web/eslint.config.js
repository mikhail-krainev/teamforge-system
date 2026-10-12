import nextPlugin from '@next/eslint-plugin-next';
import reactHooks from 'eslint-plugin-react-hooks';
import globals from 'globals';
import rootConfig from '../../eslint.config.js';
import localRules from './eslint-rules/no-jsx-literals.js';

// Extends the repository config; web-only rules live here (the root file is shared).
export default [
  ...rootConfig,
  { ignores: ['.next/**', 'next-env.d.ts', 'src/mocks/generated/**', '**/*.generated.ts'] },
  {
    languageOptions: { globals: { ...globals.browser, ...globals.node } },
  },
  reactHooks.configs.flat.recommended,
  nextPlugin.configs['core-web-vitals'],
  {
    files: ['src/**/*.tsx'],
    ignores: ['**/*.test.tsx'],
    plugins: { local: localRules },
    rules: { 'local/no-jsx-literals': 'error' },
  },
];
