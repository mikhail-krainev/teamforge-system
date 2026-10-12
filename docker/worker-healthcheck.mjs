// Healthcheck of the worker container: it has no HTTP port, so check that Redis answers with the
// worker's own ACL credentials (PING needs a successful AUTH). Exit code 0 = healthy.
import { Redis } from 'ioredis';

const client = new Redis(process.env.REDIS_URL ?? '', {
  maxRetriesPerRequest: 0,
  connectTimeout: 2000,
  retryStrategy: () => null,
});
client.on('error', () => undefined);

try {
  const reply = await client.ping();
  process.exit(reply === 'PONG' ? 0 : 1);
} catch {
  process.exit(1);
}
