import { expect, test } from '@playwright/test';
import status from '../src/i18n/ru/status.json' with { type: 'json' };
import { expectNoSeriousA11yViolations } from './support/axe';
import { startService, stopService } from './support/stack';

// Slice 1 scenario (docs/plan.md, "Тесты среза"): the home page shows the API status from healthReady,
// is accessible, and reports an outage of a mandatory dependency instead of a blank page.
test.describe('slice 1: skeleton', () => {
  // Whatever happens in the scenario, leave Redis running.
  test.afterAll(() => {
    startService('redis');
  });

  test('NFR-5.1: status card follows the readiness of the stack', async ({ page }) => {
    const ok = page.getByText(status.ok, { exact: true });
    const unavailable = page.getByText(status.unavailable, { exact: true });

    await test.step('1. open the home page', async () => {
      await page.goto('/');
      await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
    });

    await test.step('2. the "API is up" card shows the healthReady status', async () => {
      await expect(page.getByRole('heading', { name: status.heading })).toBeVisible();
      await expect(ok).toBeVisible();
    });

    await test.step('3. axe finds no serious or critical violations', async () => {
      await expectNoSeriousA11yViolations(page);
    });

    await test.step('4. Redis stopped: after a reload the outage is reported', async () => {
      stopService('redis');
      await expect(async () => {
        await page.reload();
        await expect(unavailable).toBeVisible({ timeout: 5_000 });
      }).toPass({ timeout: 40_000 });
      await expect(page.getByText(status.unavailableHint)).toBeVisible();
      await expectNoSeriousA11yViolations(page);
    });

    await test.step('5. Redis started: the status recovers', async () => {
      startService('redis');
      await expect(async () => {
        await page.reload();
        await expect(ok).toBeVisible({ timeout: 5_000 });
      }).toPass({ timeout: 60_000 });
    });
  });
});

// S1R-09: security headers of the running stack. The status card is a client component, so seeing
// "API is up" also proves that the scripts ran under the nonce-based CSP.
test.describe('slice 1: security headers', () => {
  test('pages carry a nonce CSP, the scripts run, the browser reports no CSP violation', async ({
    page,
  }) => {
    const violations: string[] = [];
    page.on('console', (message) => {
      if (/content security policy/i.test(message.text())) violations.push(message.text());
    });
    const response = await page.goto('/');
    const headers = response?.headers() ?? {};
    const csp = headers['content-security-policy'] ?? '';
    const script = csp.split('; ').find((directive) => directive.startsWith('script-src ')) ?? '';
    expect(script).toMatch(/^script-src 'self' 'nonce-[A-Za-z0-9+/=]{22,}' 'strict-dynamic'$/);
    expect(csp).toContain("frame-ancestors 'none'");
    expect(headers['x-content-type-options']).toBe('nosniff');
    expect(headers['x-frame-options']).toBe('DENY');
    expect(headers['referrer-policy']).toBe('strict-origin-when-cross-origin');
    expect(headers['permissions-policy']).toContain('camera=()');
    await expect(page.getByText(status.ok, { exact: true })).toBeVisible();
    expect(violations).toEqual([]);
  });

  test('the proxied API keeps its own headers (nosniff, no-store, no framing)', async ({
    request,
  }) => {
    const response = await request.get('/api/health/live');
    expect(response.status()).toBe(200);
    expect(response.headers()['x-content-type-options']).toBe('nosniff');
    expect(response.headers()['cache-control']).toBe('no-store');
    expect(response.headers()['x-frame-options']).toBe('DENY');
  });
});
