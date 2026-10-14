import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { fireAll } from '../../../../test/fixtures/concurrency.js';
import {
  expectOk,
  leaderVote,
  teamWithOpenSeat,
  type OfferDto,
} from '../../../../test/fixtures/teams.js';
import type { UserFixture } from '../../../../test/fixtures/index.js';
import { World } from '../../../../test/fixtures/world.js';
import { FakeClock } from '../../../../test/helpers/clock.js';
import { describeInfra, waitFor } from '../../../../test/helpers/infra.js';

interface NotificationDto {
  id: string;
  type: string;
  payload: Record<string, unknown>;
  readAt: string | null;
}

/** S3-14: notifications around the edge cases of teams (docs/plan.md, "Дополнение тестов"). */
describeInfra('S3 workspace: notifications at the edges (S3-14)', ['db', 'redis'], () => {
  let world: World;
  const clock = new FakeClock(Date.now());

  beforeAll(async () => {
    world = await World.start({ clock });
    await world.ensureCatalog(['backend', 'frontend', 'pm', 'designer', 'qa', 'devops']);
  });

  afterAll(async () => {
    if (!world) return;
    await world.close();
  });

  const list = async (who: UserFixture): Promise<NotificationDto[]> =>
    expectOk<{ items: NotificationDto[] }>(
      'listNotifications',
      await world.as(who).get('/v1/me/notifications?limit=100'),
      200,
    ).items;

  const ofType = (items: NotificationDto[], type: string, teamId: string): NotificationDto[] =>
    items.filter((n) => n.type === type && JSON.stringify(n.payload).includes(teamId));

  it('FR-WORK-19, FR-TEAM-14: the lead leaving opens a vote: every voter gets exactly one vote_opened, the leaver none', async () => {
    const f = await leaderVote(world, { phase: 'nominating' });
    for (const voter of f.eligible) {
      const got = await waitFor(async () => {
        const found = ofType(await list(voter), 'vote_opened', f.team.id);
        return found.length > 0 ? found : false;
      }, 20_000);
      expect(got).toHaveLength(1);
    }
    expect(ofType(await list(f.formerLead), 'vote_opened', f.team.id)).toHaveLength(0);
  });

  it('FR-WORK-19, FR-TEAM-17: the winner who is asked to confirm gets exactly one leader_offer', async () => {
    const f = await leaderVote(world, { phase: 'confirming' });
    const winner = f.eligible[0];
    if (!winner) throw new Error('fixture');
    const got = await waitFor(async () => {
      const found = ofType(await list(winner), 'leader_offer', f.team.id);
      return found.length > 0 ? found : false;
    }, 20_000);
    expect(got).toHaveLength(1);
    const others = f.eligible.slice(1);
    for (const other of others) {
      expect(ofType(await list(other), 'leader_offer', f.team.id)).toHaveLength(0);
    }
  });

  it('FR-WORK-19, FR-WORK-08: 20 parallel acceptances with ONE key -> one member, one member_joined notification for the lead', async () => {
    const f = await teamWithOpenSeat(world, { candidates: 1 });
    const candidate = f.candidates[0];
    const offer: OfferDto | undefined = f.offers[0];
    if (!candidate || !offer) throw new Error('fixture');
    const key = randomUUID();
    const fired = await fireAll(
      20,
      (_i, k) =>
        world
          .as(candidate)
          .post(`/v1/seat-offers/${offer.id}/acceptance`, undefined, { idempotencyKey: k }),
      Array.from({ length: 20 }, () => key),
    );
    expect(fired.filter((x) => x.status === 200).length).toBeGreaterThanOrEqual(1);
    expect(fired.every((x) => x.status === 200 || x.status === 409)).toBe(true);
    const joined = await waitFor(async () => {
      const found = (await list(f.lead)).filter(
        (n) => n.type === 'member_joined' && n.payload['userId'] === candidate.id,
      );
      return found.length > 0 ? found : false;
    }, 20_000);
    // let a late duplicate delivery show up, if there is one
    await new Promise((resolve) => setTimeout(resolve, 1_000));
    const after = (await list(f.lead)).filter(
      (n) => n.type === 'member_joined' && n.payload['userId'] === candidate.id,
    );
    expect(joined).toHaveLength(1);
    expect(after).toHaveLength(1);
  });
});
