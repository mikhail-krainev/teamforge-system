import { afterAll, beforeAll, expect, it } from 'vitest';
import { fireAll, tally } from '../fixtures/concurrency.js';
import { expectOk, manyGithubUsers, team, teamWithOpenSeat } from '../fixtures/teams.js';
import { expectNoDeadlocks } from '../fixtures/teams-db.js';
import { World } from '../fixtures/world.js';
import { describeInfra } from '../helpers/infra.js';
import type { InjectResponse } from '../helpers/http.js';

/** Far below the production 20: a transaction that needs a second connection starves the pool. */
const POOL = 3;
/** Several times the pool, so every connection is taken by a transaction at the same moment. */
const BURST = 12;
/** A healthy burst takes about a second; a starved one never finishes. */
const DEADLINE_MS = 12_000;

/** One request of the burst: who sends it and how. */
type Send = (key: string) => Promise<InjectResponse>;

/** Rejects when the burst has not finished in time: a starved pool never answers, it only waits. */
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

/**
 * B1: a join holds a pooled connection in its transaction. Every read the join makes through the
 * shared client takes another one, so `POOL` parallel joins wait for each other forever. Each
 * scenario has its own world: a starved pool does not recover, so it must not leak into the next.
 */
function joinBurst(title: string, prepare: (world: World) => Promise<Send[]>): void {
  describeInfra(`CC-14: ${title} (B1, architecture 12.1)`, ['db', 'redis'], () => {
    let world: World;
    let deadlocksBefore = 0;

    beforeAll(async () => {
      world = await World.start({ env: { DATABASE_POOL_MAX: String(POOL) } });
      await world.ensureCatalog(['backend', 'frontend', 'pm', 'designer', 'qa', 'devops']);
      deadlocksBefore = await world.deadlocks();
    });

    afterAll(async () => {
      if (!world) return;
      await expectNoDeadlocks(world, deadlocksBefore);
      await world.close();
    });

    it(`${BURST} joins at once with a pool of ${POOL} all finish with 200 and free the pool`, async () => {
      expect(world.testApp.config.DATABASE_POOL_MAX).toBe(POOL);
      const sends = await prepare(world);
      const fired = await withinDeadline(
        fireAll(BURST, (i, key) => sends[i]?.(key) ?? Promise.reject(new Error('no request'))),
      );
      expect(tally(fired)).toEqual({ 200: BURST });
      const ready = await world.app.inject({ method: 'GET', url: '/api/health/ready' });
      expect(ready.statusCode).toBe(200);
      const stuck = await world.sql<{ n: number }[]>`
        SELECT count(*)::int AS n FROM pg_stat_activity
         WHERE datname = current_database() AND state = 'idle in transaction'`;
      expect(stuck[0]?.n).toBe(0);
    }, 90_000);
  });
}

joinBurst('users accept their own seat offers', async (world) => {
  const sends: Send[] = [];
  for (let i = 0; i < BURST; i += 1) {
    const t = await teamWithOpenSeat(world, { openSeats: 1 });
    const offer = t.offers[0];
    const candidate = t.candidates[0];
    if (!offer || !candidate) throw new Error('no offer');
    sends.push((key) =>
      world
        .as(candidate)
        .post(`/v1/seat-offers/${offer.id}/acceptance`, undefined, { idempotencyKey: key }),
    );
  }
  return sends;
});

joinBurst('users accept invitations to different teams', async (world) => {
  const users = await manyGithubUsers(world, 'cc14', BURST);
  const sends: Send[] = [];
  for (const user of users) {
    const t = await team(world, { openSeats: 1 });
    const seat = t.openSeats[0];
    if (!seat) throw new Error('no seat');
    const created = expectOk<{ token: string }>(
      'createInvitation',
      await world.as(t.lead).post(`/v1/teams/${t.id}/invitations`, { seatId: seat.id }),
      201,
    );
    sends.push((key) =>
      world
        .as(user)
        .post('/v1/invitation-acceptances', { token: created.token }, { idempotencyKey: key }),
    );
  }
  return sends;
});
