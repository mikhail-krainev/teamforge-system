import { isIP } from 'node:net';
import { z } from 'zod';

/**
 * Environment of the link-checker process (architecture 13.12, 13.16). The process must not hold
 * anything it has no use for: a database, object store, session or GitHub secret in its environment is
 * a configuration error (a mistake in compose would otherwise hand them to the code that fetches
 * user-supplied addresses).
 */
const FORBIDDEN_PREFIXES = ['DATABASE_', 'S3_', 'BETTER_AUTH_', 'GITHUB_', 'DATA_ENCRYPTION_'];
const FORBIDDEN_NAMES = ['REDIS_URL', 'REDIS_RESUME_URL', 'IP_HASH_SALT', 'SMTP_URL'];

const schema = z.object({
  REDIS_LINKCHECK_URL: z.url({ protocol: /^rediss?$/ }),
  QUEUE_PREFIX: z
    .string()
    .regex(/^[a-z0-9_-]+$/)
    .default('bull'),
  NODE_ENV: z.string().optional(),
  SELF_PUBLIC_IPS: z.string().optional(),
  LINK_CHECK_CONCURRENCY: z.coerce.number().int().min(1).max(50).default(5),
  LINK_CHECK_TIMEOUT_MS: z.coerce.number().int().min(100).max(60_000).default(10_000),
  LINK_CHECK_TOTAL_TIMEOUT_MS: z.coerce.number().int().min(1_000).max(300_000).default(30_000),
});

export interface LinkCheckerEnv {
  redisUrl: string;
  queuePrefix: string;
  selfPublicIps: string[];
  concurrency: number;
  timeoutMs: number;
  /** The deadline of one check with all its redirects. */
  totalTimeoutMs: number;
}

export class LinkCheckerEnvError extends Error {}

/** Names of the variables that must not be set, so the message never contains a value. */
export function forbiddenVariables(env: NodeJS.ProcessEnv): string[] {
  return Object.keys(env).filter(
    (name) =>
      env[name] !== undefined &&
      env[name] !== '' &&
      (FORBIDDEN_NAMES.includes(name) || FORBIDDEN_PREFIXES.some((p) => name.startsWith(p))),
  );
}

export function loadLinkCheckerEnv(env: NodeJS.ProcessEnv): LinkCheckerEnv {
  const forbidden = forbiddenVariables(env);
  if (forbidden.length > 0) {
    throw new LinkCheckerEnvError(
      `Not allowed in the link-checker environment: ${forbidden.join(', ')}`,
    );
  }
  const parsed = schema.safeParse(env);
  if (!parsed.success) {
    const names = [...new Set(parsed.error.issues.map((issue) => String(issue.path[0] ?? 'env')))];
    throw new LinkCheckerEnvError(`Invalid link-checker environment: ${names.join(', ')}`);
  }
  const own = (parsed.data.SELF_PUBLIC_IPS ?? '')
    .split(',')
    .map((ip) => ip.trim())
    .filter((ip) => ip !== '');
  if (own.some((ip) => isIP(ip) === 0)) {
    throw new LinkCheckerEnvError('Invalid link-checker environment: SELF_PUBLIC_IPS');
  }
  // Fail closed: without its own public addresses the checker cannot refuse a request to a service of this
  // server, so every environment but the two local ones (a missing or misspelled NODE_ENV included) needs them.
  const isLocalEnvironment = ['development', 'test'].includes(parsed.data.NODE_ENV ?? '');
  if (!isLocalEnvironment && own.length === 0) {
    throw new LinkCheckerEnvError(
      'Invalid link-checker environment: SELF_PUBLIC_IPS (required outside development and test)',
    );
  }
  return {
    redisUrl: parsed.data.REDIS_LINKCHECK_URL,
    queuePrefix: parsed.data.QUEUE_PREFIX,
    selfPublicIps: own,
    concurrency: parsed.data.LINK_CHECK_CONCURRENCY,
    timeoutMs: parsed.data.LINK_CHECK_TIMEOUT_MS,
    totalTimeoutMs: parsed.data.LINK_CHECK_TOTAL_TIMEOUT_MS,
  };
}
