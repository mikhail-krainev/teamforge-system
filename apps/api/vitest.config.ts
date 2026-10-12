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
    },
  },
  // Vite 8 transforms TS with oxc; Nest needs legacy (experimental) decorators incl. parameter ones.
  oxc: { target: 'es2023', decorator: { legacy: true } },
});
