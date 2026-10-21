import { createPrivateKey } from 'node:crypto';
import { isWeakSecret } from './secrets.js';

/**
 * GitHub App settings of architecture 7.1 and 13.11. The four values below are one group: the group
 * is either complete and valid or the process does not start (fail fast); only a production
 * instance must have it, a development or test instance may run without GitHub.
 */
export const GITHUB_APP_VARIABLES = [
  'GITHUB_APP_ID',
  'GITHUB_APP_SLUG',
  'GITHUB_APP_PRIVATE_KEY',
  'GITHUB_WEBHOOK_SECRET',
] as const;

export type GithubAppVariable = (typeof GITHUB_APP_VARIABLES)[number];

const APP_ID = /^[1-9]\d{0,17}$/;
const SLUG = /^[a-z0-9](?:[a-z0-9-]{0,38})$/i;
const MIN_WEBHOOK_SECRET_LENGTH = 16;

/** `.env` files and compose cannot hold a multi-line value, so the key may carry `\n` escapes. */
export function normalizePrivateKey(value: string): string {
  return value.includes('\\n') ? value.replaceAll('\\n', '\n') : value;
}

function isRsaPrivateKey(value: string): boolean {
  try {
    return createPrivateKey(normalizePrivateKey(value)).asymmetricKeyType === 'rsa';
  } catch {
    return false;
  }
}

const VALIDATORS: Record<GithubAppVariable, (value: string) => boolean> = {
  GITHUB_APP_ID: (value) => APP_ID.test(value),
  GITHUB_APP_SLUG: (value) => SLUG.test(value),
  GITHUB_APP_PRIVATE_KEY: isRsaPrivateKey,
  GITHUB_WEBHOOK_SECRET: (value) => !isWeakSecret(value, MIN_WEBHOOK_SECRET_LENGTH),
};

export interface GithubAppIssue {
  name: GithubAppVariable;
  reason: 'missing' | 'invalid';
}

/** Names only, never values: the result is printed at startup. */
export function githubAppIssues(
  env: Partial<Record<GithubAppVariable, string | undefined>>,
  isProduction: boolean,
): GithubAppIssue[] {
  const present = GITHUB_APP_VARIABLES.filter((name) => env[name] !== undefined);
  if (present.length === 0 && !isProduction) return [];
  return GITHUB_APP_VARIABLES.flatMap((name): GithubAppIssue[] => {
    const value = env[name];
    if (value === undefined) return [{ name, reason: 'missing' }];
    return VALIDATORS[name](value) ? [] : [{ name, reason: 'invalid' }];
  });
}

export interface GithubAppSettings {
  appId: string;
  slug: string;
  privateKey: string;
  webhookSecret: string;
}

/** The validated group, or `null` when GitHub is not configured (development and test only). */
export function githubAppSettings(
  env: Partial<Record<GithubAppVariable, string | undefined>>,
): GithubAppSettings | null {
  const { GITHUB_APP_ID, GITHUB_APP_SLUG, GITHUB_APP_PRIVATE_KEY, GITHUB_WEBHOOK_SECRET } = env;
  if (
    GITHUB_APP_ID === undefined ||
    GITHUB_APP_SLUG === undefined ||
    GITHUB_APP_PRIVATE_KEY === undefined ||
    GITHUB_WEBHOOK_SECRET === undefined
  ) {
    return null;
  }
  return {
    appId: GITHUB_APP_ID,
    slug: GITHUB_APP_SLUG,
    privateKey: normalizePrivateKey(GITHUB_APP_PRIVATE_KEY),
    webhookSecret: GITHUB_WEBHOOK_SECRET,
  };
}
