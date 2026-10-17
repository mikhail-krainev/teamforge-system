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
      exclude: [
        'src/**/*.test.ts',
        'src/main.ts',
        'src/worker.ts',
        // Entry point of the one-off job CLI: bootstrap only; its argument handling is run-job-args.ts.
        'src/cli/run-job.ts',
        // Process entry points of the resume sandbox: bootstrap only (they start on import), covered
        // by the docker e2e stack; their logic lives in run-child.ts, parsers.ts and protocol.ts.
        'src/resume-worker/main.ts',
        'src/resume-worker/child.ts',
        // Barrel re-exports and type-only files hold no runtime logic.
        'src/**/index.ts',
        'src/**/*.types.ts',
      ],
      reporter: ['text', 'text-summary', 'lcov'],
      // Plan: line coverage of 80% is checked in CI (docs/plan.md, "Правила тестов"). Measured with
      // all services present (pnpm run test:coverage): lines 91%, branches 84%.
      thresholds: { lines: 80, statements: 80, functions: 80, branches: 80 },
    },
  },
  // Vite 8 transforms TS with oxc; Nest needs legacy (experimental) decorators incl. parameter ones.
  oxc: { target: 'es2023', decorator: { legacy: true } },
});
