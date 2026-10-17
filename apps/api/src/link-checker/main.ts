import { Redis } from 'ioredis';
import { loadLinkCheckerEnv } from './env.js';
import { createHttpsHop, resolveAddresses } from './https-hop.js';
import { startLinkCheckWorker } from './link-check-worker.js';
import { createLinkChecker } from './ssrf-client.js';

const log = (
  level: 'info' | 'error',
  message: string,
  fields: Record<string, unknown> = {},
): void => {
  process.stdout.write(`${JSON.stringify({ level, msg: message, ...fields })}\n`);
};

/**
 * Process `link-checker` (architecture 13.12): takes jobs of the `link-check` queue and answers with a
 * code. It starts without a database or object store and refuses to start when their variables are set.
 */
function start(): void {
  const env = loadLinkCheckerEnv(process.env);
  const connection = new Redis(env.redisUrl, { maxRetriesPerRequest: null });
  const checker = createLinkChecker({
    resolve: resolveAddresses,
    request: createHttpsHop(),
    selfPublicIps: env.selfPublicIps,
    timeoutMs: env.timeoutMs,
  });
  const worker = startLinkCheckWorker({
    connection,
    prefix: env.queuePrefix,
    checker,
    concurrency: env.concurrency,
    onError: (error) => log('error', 'worker error', { error: error.message }),
  });
  const stop = (): void => {
    void worker.close().then(() => connection.quit().then(() => process.exit(0)));
  };
  process.on('SIGTERM', stop);
  process.on('SIGINT', stop);
  log('info', 'link-checker started');
}

try {
  start();
} catch (error: unknown) {
  process.stderr.write(
    `link-checker failed to start: ${error instanceof Error ? error.message : 'unknown error'}\n`,
  );
  process.exit(1);
}
