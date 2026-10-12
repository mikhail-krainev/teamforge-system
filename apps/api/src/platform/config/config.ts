import { z } from 'zod';

/** Long-running process roles. The migrate job has its own minimal config (see loadMigrateConfig). */
export type ProcessRole = 'api' | 'worker';

const WEAK_SECRETS = new Set([
  'changeme',
  'change-me',
  'secret',
  'password',
  'default',
  'example',
  'test',
  'development',
]);

/** A secret is weak when it is short, a known placeholder, or has too few distinct characters. */
export function isWeakSecret(value: string, minLength = 32): boolean {
  if (value.length < minLength) return true;
  if (WEAK_SECRETS.has(value.toLowerCase())) return true;
  return new Set(value).size < 10;
}

const secret = (minLength = 32) =>
  z.string().refine((v) => !isWeakSecret(v, minLength), { message: 'weak' });

/** 32 random bytes as 64 hex characters or base64 (43-44 characters). */
const encryptionKey = z.string().refine(
  (v) => {
    if (isWeakSecret(v, 32)) return false;
    if (/^[0-9a-fA-F]{64}$/.test(v)) return true;
    return Buffer.from(v, 'base64').length === 32;
  },
  { message: 'invalid' },
);

const url = (protocols: string[]) =>
  z.string().refine(
    (v) => {
      try {
        return protocols.includes(new URL(v).protocol);
      } catch {
        return false;
      }
    },
    { message: 'invalid' },
  );

const postgresUrl = url(['postgres:', 'postgresql:']);
const redisUrl = url(['redis:', 'rediss:']);
const httpUrl = url(['http:', 'https:']);
const optionalString = z
  .string()
  .optional()
  .transform((v) => (v === '' ? undefined : v));

const cidr = z.string().regex(/^[0-9a-fA-F:.]+(\/\d{1,3})?$/, { message: 'invalid' });
const cidrList = z
  .string()
  .default('')
  .transform((v) =>
    v
      .split(',')
      .map((s) => s.trim())
      .filter((s) => s !== ''),
  )
  .pipe(z.array(cidr));

const port = z.coerce.number().int().min(1).max(65535);

/** Full schema of the variables from architecture 13.11. Role-specific requirements are applied later. */
export const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  API_PORT: port.default(4000),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),
  DATABASE_URL: postgresUrl,
  DATABASE_DIRECT_URL: postgresUrl.optional(),
  DATABASE_POOL_MAX: z.coerce.number().int().min(1).max(100).default(20),
  REDIS_URL: redisUrl,
  REDIS_LINKCHECK_URL: redisUrl.optional(),
  REDIS_RESUME_URL: redisUrl.optional(),
  /** BullMQ key prefix; the Redis ACL grants `~bull:*`, tests use a unique prefix per run. */
  QUEUE_PREFIX: z
    .string()
    .regex(/^[a-z0-9_-]+$/)
    .default('bull'),
  SELF_PUBLIC_IPS: optionalString,
  TRUSTED_PROXY_CIDRS: cidrList,
  S3_ENDPOINT: httpUrl,
  S3_ACCESS_KEY: z.string().min(1),
  S3_SECRET_KEY: z.string().min(1),
  S3_BUCKET_RESUMES: z.string().min(1),
  S3_BUCKET_ARTIFACTS: z.string().min(1),
  FILES_PUBLIC_ORIGIN: httpUrl,
  BETTER_AUTH_SECRET: secret(),
  BETTER_AUTH_URL: httpUrl,
  APP_ORIGIN: httpUrl,
  GITHUB_OAUTH_CLIENT_ID: optionalString,
  GITHUB_OAUTH_CLIENT_SECRET: optionalString,
  GITHUB_APP_ID: optionalString,
  GITHUB_APP_SLUG: optionalString,
  GITHUB_APP_PRIVATE_KEY: optionalString,
  GITHUB_APP_CLIENT_ID: optionalString,
  GITHUB_APP_CLIENT_SECRET: optionalString,
  /** Base URLs of GitHub (OAuth pages and REST API); only tests point them at a double. */
  GITHUB_OAUTH_BASE_URL: optionalString.pipe(httpUrl.optional()),
  GITHUB_API_BASE_URL: optionalString.pipe(httpUrl.optional()),
  GITHUB_WEBHOOK_SECRET: optionalString,
  DATA_ENCRYPTION_KEY: encryptionKey,
  IP_HASH_SALT: secret(),
  BACKUP_AGE_RECIPIENT: optionalString,
  SMTP_URL: url(['smtp:', 'smtps:']).optional(),
  MAIL_FROM: optionalString,
  ADMIN_GITHUB_IDS: optionalString,
  /** Require `user:password@` in Redis URLs and check `ACL WHOAMI` (architecture 13.16). */
  REDIS_ACL_STRICT: z
    .enum(['true', 'false'])
    .optional()
    .transform((v) => (v === undefined ? undefined : v === 'true')),
});

export type AppConfig = Omit<z.infer<typeof envSchema>, 'REDIS_ACL_STRICT'> & {
  readonly REDIS_ACL_STRICT: boolean;
  readonly role: ProcessRole;
};

const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);

/** True for http(s) addresses of this machine; `*.localhost` counts as loopback too. */
export function isLoopbackOrigin(origin: string): boolean {
  try {
    const host = new URL(origin).hostname;
    return LOOPBACK_HOSTS.has(host) || host.endsWith('.localhost');
  } catch {
    return false;
  }
}

/**
 * `NODE_ENV=test` switches on test-only behaviour (lock order checks, the header-based test
 * session in the test bootstrap). A deployed instance must never run in that mode, so it is
 * accepted only together with a loopback `APP_ORIGIN` (S1R-08).
 */
function environmentIssues(parsed: z.infer<typeof envSchema>): ConfigIssue[] {
  const issues: ConfigIssue[] = [];
  if (parsed.NODE_ENV === 'test' && !isLoopbackOrigin(parsed.APP_ORIGIN)) {
    issues.push({ name: 'APP_ORIGIN', reason: 'invalid' });
  }
  // A production instance must talk to the real GitHub: client secrets are sent to these hosts.
  if (parsed.NODE_ENV === 'production') {
    if (parsed.GITHUB_OAUTH_BASE_URL !== undefined) {
      issues.push({ name: 'GITHUB_OAUTH_BASE_URL', reason: 'invalid' });
    }
    if (parsed.GITHUB_API_BASE_URL !== undefined) {
      issues.push({ name: 'GITHUB_API_BASE_URL', reason: 'invalid' });
    }
  }
  return issues;
}

/** Variables that only some roles must provide (checked after the schema passes). */
const REQUIRED_BY_ROLE: Record<ProcessRole, readonly (keyof z.infer<typeof envSchema>)[]> = {
  api: [],
  worker: ['SMTP_URL', 'MAIL_FROM'],
};

export type ConfigIssue = { name: string; reason: 'missing' | 'invalid' };

export class ConfigError extends Error {
  constructor(readonly issues: readonly ConfigIssue[]) {
    super(`Invalid configuration: ${issues.map((i) => `${i.name} (${i.reason})`).join(', ')}`);
    this.name = 'ConfigError';
  }
}

function isMissing(env: NodeJS.ProcessEnv, name: string): boolean {
  const value = env[name];
  return value === undefined || value === '';
}

function collectIssues(error: z.ZodError, env: NodeJS.ProcessEnv): ConfigIssue[] {
  const byName = new Map<string, ConfigIssue>();
  for (const issue of error.issues) {
    const name = String(issue.path[0] ?? 'env');
    byName.set(name, { name, reason: isMissing(env, name) ? 'missing' : 'invalid' });
  }
  return [...byName.values()];
}

function roleIssues(
  parsed: z.infer<typeof envSchema>,
  role: ProcessRole,
  env: NodeJS.ProcessEnv,
): ConfigIssue[] {
  return REQUIRED_BY_ROLE[role]
    .filter((name) => parsed[name] === undefined)
    .map((name) => ({ name, reason: isMissing(env, name) ? 'missing' : 'invalid' }) as ConfigIssue);
}

/**
 * Parses and validates the environment. Throws ConfigError carrying variable names only,
 * never values, so the result can be printed safely.
 */
export function loadConfig(env: NodeJS.ProcessEnv, role: ProcessRole): AppConfig {
  const result = envSchema.safeParse(env);
  if (!result.success) throw new ConfigError(collectIssues(result.error, env));
  const missing = [...environmentIssues(result.data), ...roleIssues(result.data, role, env)];
  if (missing.length > 0) throw new ConfigError(missing);
  const strict = result.data.REDIS_ACL_STRICT ?? result.data.NODE_ENV !== 'test';
  return Object.freeze({ ...result.data, REDIS_ACL_STRICT: strict, role });
}

/** Prints variable names (no values) to stderr and exits with code 1. */
export function reportConfigErrorAndExit(error: ConfigError): never {
  const lines = error.issues.map((i) => `  ${i.name}: ${i.reason}`);
  process.stderr.write(
    `Configuration error, fix these environment variables:\n${lines.join('\n')}\n`,
  );
  process.exit(1);
}

/** Entry-point helper: prints variable names (no values) to stderr and exits with code 1. */
export function loadConfigOrExit(env: NodeJS.ProcessEnv, role: ProcessRole): AppConfig {
  try {
    return loadConfig(env, role);
  } catch (error) {
    if (!(error instanceof ConfigError)) throw error;
    return reportConfigErrorAndExit(error);
  }
}

const migrateSchema = z.object({ DATABASE_DIRECT_URL: postgresUrl });

/** The migrate job needs only the direct database URL, none of the application secrets. */
export function loadMigrateConfig(env: NodeJS.ProcessEnv): { DATABASE_DIRECT_URL: string } {
  const result = migrateSchema.safeParse(env);
  if (!result.success) throw new ConfigError(collectIssues(result.error, env));
  return result.data;
}

export function loadMigrateConfigOrExit(env: NodeJS.ProcessEnv): { DATABASE_DIRECT_URL: string } {
  try {
    return loadMigrateConfig(env);
  } catch (error) {
    if (!(error instanceof ConfigError)) throw error;
    reportConfigErrorAndExit(error);
  }
}
