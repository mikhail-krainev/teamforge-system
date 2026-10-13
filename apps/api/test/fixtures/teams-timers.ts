import { Queue } from 'bullmq';
import { Redis } from 'ioredis';
import { waitFor } from '../helpers/infra.js';
import type { World } from './world.js';

/**
 * Runs one job of the `timers` queue (architecture 13.12: `vote-deadline`, `trial-expire`,
 * `departure-default`, `suspension-expire`, ...) in the test worker NOW, so that a test decides
 * when a timer fires instead of waiting for BullMQ's wall-clock delay (the FakeClock does not move
 * BullMQ). The job name is the documented one; the data shape is an assumption of this suite:
 * `{ <aggregate>Id }`, e.g. `{ departureId }` for `departure-default`. The deterministic jobId is
 * three `_` segments (architecture 13.12).
 *
 * If the implementation names the payload differently, only this helper needs to change.
 */
let sequence = 0;

export async function fireTimer(
  world: World,
  name: 'departure-default' | 'suspension-expire',
  data: Record<string, string>,
): Promise<void> {
  const connection = new Redis(process.env.REDIS_URL ?? '', { maxRetriesPerRequest: null });
  const queue = new Queue('timers', { connection, prefix: world.queuePrefix });
  try {
    sequence += 1;
    const aggregate = Object.values(data)[0] ?? 'none';
    const job = await queue.add(name, data, {
      jobId: `${name.replaceAll('-', '')}_${aggregate}_test${sequence}`,
      removeOnComplete: false,
    });
    await waitFor(
      async () => {
        if (await job.isFailed()) throw new Error(`timer ${name} failed`);
        return job.isCompleted();
      },
      30_000,
      50,
    );
  } finally {
    await queue.close();
    connection.disconnect();
  }
}
