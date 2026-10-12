import { defineConfig, devices } from '@playwright/test';
import { E2E_ENV, E2E_PROJECT, E2E_WEB_URL } from './e2e/support/stack';

// End-to-end tests run in a real browser against the whole stack from docker-compose.yml, started as
// the separate compose project `e2e` (own containers, volumes and ports; the dev stack is untouched).
// `webServer` keeps `docker compose up` in the foreground until the web container answers;
// global-teardown removes the project (set E2E_KEEP_STACK=1 to keep it for debugging).
export default defineConfig({
  testDir: './e2e',
  testMatch: '**/*.spec.ts',
  // Scenarios stop and start containers, so they must not run in parallel.
  fullyParallel: false,
  workers: 1,
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 1 : 0,
  timeout: 120_000,
  expect: { timeout: 10_000 },
  reporter: process.env.CI ? [['list'], ['html', { open: 'never' }]] : [['list']],
  globalTeardown: './e2e/support/global-teardown.ts',
  use: {
    baseURL: E2E_WEB_URL,
    locale: 'ru-RU',
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: {
    command: `node scripts/env-init.mjs && docker compose -p ${E2E_PROJECT} up --build`,
    cwd: '../..',
    env: E2E_ENV,
    url: E2E_WEB_URL,
    // The first run builds both images (several minutes on a cold cache).
    timeout: 900_000,
    reuseExistingServer: !process.env.CI,
    stdout: 'pipe',
    stderr: 'pipe',
  },
});
