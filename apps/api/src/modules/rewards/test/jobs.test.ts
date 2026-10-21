import { Queue, type JobSchedulerJson } from 'bullmq';
import { Redis } from 'ioredis';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { completedProject, COOLING_MS, type Project } from '../../../../test/fixtures/rewards.js';
import { creditRunCount } from '../../../../test/fixtures/rewards-db.js';
import { describeInfra } from '../../../../test/helpers/infra.js';
import { startRewardsWorld, type RewardsWorld } from './support.js';

/*
 * S7-02 (written before the implementation): what the module registers in the queues (architecture 10.1, 13.12):
 *   - the timer `rewards-cooling-end` of the queue `timers`, `jobId = credit_<teamId>`, delayed by the cooling;
 *   - the scheduler `credit-run-scan` of `maintenance` every 10 minutes (the net for a lost completion event);
 *   - the scheduler `pending-account-recheck` of `maintenance` daily (FR-GH-09);
 *   - the schedulers of profiles: `review-eligibility-scan`, `review-purge` (SEC-04) - the contract of the
 *     queues test (test/integration/queues.test.ts) lists them too when S7-02 and S7-07 are done.
 * The deterministic job id makes a second timer for one team impossible (CC-6).
 */

const TEN_MINUTES = 600_000;
const DAY = 86_400_000;

describeInfra('S7 rewards: timers and schedulers (FR-REW-11, CC-6)', ['db', 'redis', 's3'], () => {
  let rw: RewardsWorld;
  let project: Project;
  let connection: Redis;
  let timers: Queue;
  let maintenance: Queue;

  beforeAll(async () => {
    rw = await startRewardsWorld();
    project = await completedProject(rw.world);
    connection = new Redis(process.env.REDIS_URL ?? '', { maxRetriesPerRequest: null });
    timers = new Queue('timers', { connection, prefix: rw.world.queuePrefix });
    maintenance = new Queue('maintenance', { connection, prefix: rw.world.queuePrefix });
  }, 240_000);

  afterAll(async () => {
    await timers?.close();
    await maintenance?.close();
    connection?.disconnect();
    if (rw) await rw.close();
  });

  const everyOf = (s: JobSchedulerJson | undefined): number | undefined =>
    s?.every === undefined || s.every === null ? undefined : Number(s.every);

  it('FR-REW-11, CC-6: the completion puts the timer credit_<teamId> into `timers`, delayed by 7 days, once', async () => {
    const job = await timers.getJob(`credit_${project.fx.team.id}`);
    expect(job, 'the timer of the cooling').toBeDefined();
    expect(job?.name).toBe('rewards-cooling-end');
    expect(job?.data).toMatchObject({ teamId: project.fx.team.id });
    expect(await job?.getState()).toBe('delayed');
    const delay = job?.opts.delay ?? 0;
    expect(delay).toBeLessThanOrEqual(COOLING_MS);
    expect(delay).toBeGreaterThan(COOLING_MS - 5 * 60_000);
    expect(await creditRunCount(rw.world, project.fx.team.id)).toBe(1);
  });

  it('CC-6: adding the same timer again does not create a second job', async () => {
    const id = `credit_${project.fx.team.id}`;
    await timers.add(
      'rewards-cooling-end',
      { teamId: project.fx.team.id },
      { jobId: id, delay: COOLING_MS },
    );
    const jobs = (await timers.getJobs(['delayed', 'waiting', 'active'])).filter(
      (j) => j.id === id,
    );
    expect(jobs).toHaveLength(1);
  });

  it('FR-REW-11: credit-run-scan is registered every 10 minutes in `maintenance`', async () => {
    const schedulers = await maintenance.getJobSchedulers();
    const scan = schedulers.find((s) => s.key === 'credit-run-scan');
    expect(scan, `schedulers: ${schedulers.map((s) => s.key).join(', ')}`).toBeDefined();
    expect(everyOf(scan) === TEN_MINUTES || scan?.pattern === '*/10 * * * *').toBe(true);
  });

  it('FR-GH-09: pending-account-recheck is registered once a day in `maintenance`', async () => {
    const schedulers = await maintenance.getJobSchedulers();
    const recheck = schedulers.find((s) => s.key === 'pending-account-recheck');
    expect(recheck, `schedulers: ${schedulers.map((s) => s.key).join(', ')}`).toBeDefined();
    expect(everyOf(recheck) === DAY || /^\d+ \d+ \* \* \*$/.test(recheck?.pattern ?? '')).toBe(
      true,
    );
  });

  it('FR-PROF-08: the schedulers of the reviews are registered: review-eligibility-scan and review-purge', async () => {
    const keys = (await maintenance.getJobSchedulers()).map((s) => s.key);
    expect(keys).toEqual(expect.arrayContaining(['review-eligibility-scan', 'review-purge']));
  });
});
