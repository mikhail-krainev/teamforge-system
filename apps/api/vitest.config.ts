import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['src/**/*.test.ts', 'test/**/*.test.ts'],
    globalSetup: ['./test/setup/global-setup.ts'],
    testTimeout: 30_000,
    hookTimeout: 60_000,
    pool: 'forks',
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts'],
      exclude: ['src/**/*.test.ts', 'src/main.ts', 'src/worker.ts'],
      reporter: ['text', 'text-summary', 'lcov'],
      // Plan: line coverage of 80% is checked in CI (docs/plan.md, "Правила тестов"). Measured with
      // all services present (pnpm run test:coverage): lines 91%, branches 84%.
      thresholds: { lines: 80, statements: 80, functions: 80, branches: 80 },
    },
  },
  // Vite 8 transforms TS with oxc; Nest needs legacy (experimental) decorators incl. parameter ones.
  oxc: { target: 'es2023', decorator: { legacy: true } },
});
