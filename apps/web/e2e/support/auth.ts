import type { Page } from '@playwright/test';

export interface E2eUser {
  /** Internal user id (UUID) the session is created for. */
  id: string;
  role?: 'member' | 'admin';
}

/**
 * Sign-in helper: creates a session directly in Redis (Better Auth session record) and sets the
 * session cookie in the browser, bypassing the magic-link/GitHub flow (plan, "Фикстуры").
 *
 * Slice 1 has no authentication, so there is nothing to sign in to yet. The signature is fixed so
 * that slice 2 (Better Auth) only fills in the body and every later scenario can call it.
 */
export function signIn(page: Page, user: E2eUser): Promise<void> {
  return Promise.reject(
    new Error(
      `signIn(${user.id}) on ${page.url() || 'about:blank'}: placeholder until slice 2 introduces Better Auth sessions`,
    ),
  );
}
