import { afterAll, beforeAll, expect, it } from 'vitest';
import { CreditRunService } from '../../src/modules/rewards/internal/services/credit-run.service.js';
import { TxRunner } from '../../src/platform/tx/tx-runner.js';
import { fireAll, tally } from '../fixtures/concurrency.js';
import {
  completedProject,
  decide,
  endCooling,
  openCaseOf,
  type Project,
} from '../fixtures/rewards.js';
import { creditRunCount, creditRunRow } from '../fixtures/rewards-db.js';
import { startRewardsWorld, type RewardsWorld } from '../fixtures/rewards-world.js';
import { expectNoDeadlocks } from '../fixtures/teams-db.js';
import { describeInfra } from '../helpers/infra.js';

/*
 * CC-14 for slice 7 (review C-1, B1, architecture 12.1): the anti-fraud facts are read inside the transaction of
 * `CreditRunService.open` (the consumer of `workspace.project_completed` and `credit-run-scan`) and of the decision
 * "ok" after the cooling (`creditProject` in the decision's transaction). Every one of those reads must go through
 * the connection of the transaction: a read through the shared client takes a second pooled connection, and as many
 * transactions as the pool holds then wait for each other forever. The pool here is far below the production 20.
 */

const POOL = 5;
const OPENS = 25;
const DECISIONS = 10;
/** A healthy burst finishes in seconds; a starved pool never does. */
const DEADLINE_MS = 30_000;
const COMMENT = 'Проверено вручную: параллельные решения при малом пуле.';

async function withinDeadline<T>(burst: Promise<T>): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const expired = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new Error(`the burst did not finish in ${DEADLINE_MS} ms: pool starvation`)),
      DEADLINE_MS,
    );
  });
  try {
    return await Promise.race([burst, expired]);
  } finally {
    clearTimeout(timer);
  }
}

describeInfra(
  `CC-14: the credit run and the decision with a pool of ${POOL} (review C-1, B1)`,
  ['db', 'redis', 's3'],
  () => {
    let rw: RewardsWorld;
    let deadlocksBefore = 0;

    beforeAll(async () => {
      rw = await startRewardsWorld({ env: { DATABASE_POOL_MAX: String(POOL) } });
      deadlocksBefore = await rw.world.deadlocks();
    }, 120_000);

    afterAll(async () => {
      if (!rw) return;
      await expectNoDeadlocks(rw.world, deadlocksBefore);
      await rw.close();
    });

    async function expectPoolFree(): Promise<void> {
      const ready = await rw.world.app.inject({ method: 'GET', url: '/api/health/ready' });
      expect(ready.statusCode).toBe(200);
      const stuck = await rw.world.sql<{ n: number }[]>`
        SELECT count(*)::int AS n FROM pg_stat_activity
         WHERE datname = current_database() AND state = 'idle in transaction'`;
      expect(stuck[0]?.n).toBe(0);
    }

    it(`${OPENS} parallel opens of a credit run (all anti-fraud facts read in each transaction) finish; one run is opened`, async () => {
      expect(rw.world.testApp.config.DATABASE_POOL_MAX).toBe(POOL);
      const project: Project = await completedProject(rw.world);
      const teamId = project.fx.team.id;
      // Forget the run the completion opened, so that every open of the burst reads the facts again.
      await rw.world.sql`DELETE FROM rewards.fraud_signal WHERE team_id = ${teamId}`;
      await rw.world.sql`DELETE FROM rewards.credit_run WHERE team_id = ${teamId}`;
      const tx = rw.world.app.get(TxRunner);
      const runs = rw.world.app.get(CreditRunService);
      const opened = await withinDeadline(
        Promise.all(Array.from({ length: OPENS }, () => tx.run(() => runs.open(teamId)))),
      );
      expect(opened.filter(Boolean)).toHaveLength(1);
      expect(await creditRunCount(rw.world, teamId)).toBe(1);
      expect((await creditRunRow(rw.world, teamId))?.status).toBe('cooling');
      await expectPoolFree();
    }, 300_000);

    it(`${DECISIONS} parallel decisions "ok" after the cooling (the credit of the phase cooling_end in the transaction) finish; one wins`, async () => {
      const project = await completedProject(rw.world, { prLines: 20 });
      const teamId = project.fx.team.id;
      await endCooling(project);
      expect((await creditRunRow(rw.world, teamId))?.status).toBe('frozen');
      const caseId = (await openCaseOf(rw.world, rw.admin, teamId)).id;
      const fired = await withinDeadline(
        fireAll(DECISIONS, (_i, key) => decide(rw.world, rw.admin, caseId, 'ok', key, COMMENT)),
      );
      const counts = tally(fired);
      expect(counts[200]).toBe(1);
      // The losers wait for lock #11 and are refused after it (409), or give up waiting (503 LOCK_TIMEOUT).
      expect((counts[409] ?? 0) + (counts[503] ?? 0)).toBe(DECISIONS - 1);
      expect((await creditRunRow(rw.world, teamId))?.status).toBe('credited');
      await expectPoolFree();
    }, 300_000);
  },
);
