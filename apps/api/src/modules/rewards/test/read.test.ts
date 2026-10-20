import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { expectProblem } from '../../../../test/fixtures/assertions.js';
import type { UserFixture } from '../../../../test/fixtures/index.js';
import {
  type BadgeDto,
  type BadgeListDto,
  awardsOk,
  countersOk,
  listBadges,
  userAwards,
  userCounters,
  plantHistory,
  teamCredit,
} from '../../../../test/fixtures/rewards.js';
import { activeAwardNames } from '../../../../test/fixtures/rewards-db.js';
import { expectOk, githubUser, team, TEAM_ROLES } from '../../../../test/fixtures/teams.js';
import { World } from '../../../../test/fixtures/world.js';
import { FakeClock } from '../../../../test/helpers/clock.js';
import { describeInfra } from '../../../../test/helpers/infra.js';
import { expectNoFraudDetails, keysDeep } from './support.js';

/*
 * S7-06 (written before the implementation): the read operations of rewards - listBadges, listUserAwards,
 * getUserCounters, getTeamCredit (FR-REW-04, FR-REW-05, FR-REW-14, FR-PROF-06). Everything here works without a
 * credited project: the catalog is the seed of S7-02, the others read what is planted with `plantHistory`.
 *
 * ASSUMPTIONS (the contract leaves them open):
 *   - the catalog is the 12 badges of FR-REW-05; the codes of `badge_def` are not fixed, so tests look badges up by
 *     the name of the table in FR-REW-05;
 *   - getTeamCredit of a team that has not completed its project is 404 NOT_FOUND (there is no credit_run yet);
 *   - an unknown user is 404 for awards and counters; a user without credits has zero counters, not 404.
 */

const NOWHERE = '00000000-0000-4000-8000-000000000999';

describeInfra('S7 rewards: reading badges, awards and counters (FR-REW-04, FR-REW-05, FR-REW-14)', ['db', 'redis'], () => {
  let world: World;
  let viewer: UserFixture;
  const clock = new FakeClock(Date.now());

  beforeAll(async () => {
    world = await World.start({ clock });
    await world.ensureCatalog(TEAM_ROLES);
    viewer = await world.createUser('viewer');
  });

  afterAll(async () => {
    if (!world) return;
    await world.close();
  });

  describe('listBadges: the catalog (FR-REW-05)', () => {
    const catalog = async (): Promise<BadgeDto[]> =>
      expectOk<BadgeListDto>('listBadges', await listBadges(world, viewer), 200).items;

    const byName = async (name: string): Promise<BadgeDto | undefined> =>
      (await catalog()).find((b) => b.name === name);

    it('FR-REW-05: twelve badges, the series have the steps of the table', async () => {
      const badges = await catalog();
      expect(badges).toHaveLength(12);
      const steps = (series: string): (number | null)[] =>
        badges
          .filter((b) => b.series === series)
          .map((b) => b.step)
          .sort();
      expect(steps('projects')).toEqual([1, 2, 3, 4]);
      expect(steps('roles')).toEqual([1, 2]);
      expect(steps('product_types')).toEqual([1, 2]);
    });

    it.each([
      ['Первый релиз', 'projects', 1],
      ['Трое в строю', 'projects', 2],
      ['Пятёрка проектов', 'projects', 3],
      ['Десять из десяти', 'projects', 4],
      ['Многоликий', 'roles', 1],
      ['Универсал', 'roles', 2],
      ['Разные берега', 'product_types', 1],
      ['Коллекционер форматов', 'product_types', 2],
    ] as const)('FR-REW-05: "%s" is %s, step %i', async (name, series, step) => {
      expect(await byName(name)).toMatchObject({ series, step, scope: 'individual' });
    });

    it.each(['В срок', 'Три в срок подряд', 'Закрыл дефицит'])(
      'FR-REW-05: "%s" is a separate individual badge without a series',
      async (name) => {
        expect(await byName(name)).toMatchObject({ series: null, step: null, scope: 'individual' });
      },
    );

    it('FR-REW-05, FR-REW-10: "Закрытая вакансия" is the only team badge', async () => {
      const badges = await catalog();
      expect(badges.filter((b) => b.scope === 'team').map((b) => b.name)).toEqual(['Закрытая вакансия']);
    });

    it('FR-REW-05: step 4 of "Типы продукта" is unreachable in the MVP (available=false), everything else is available', async () => {
      const badges = await catalog();
      expect(badges.filter((b) => !b.available).map((b) => b.name)).toEqual(['Коллекционер форматов']);
    });

    it('FR-REW-05: the steps are called "ступени серии", never levels or metals', async () => {
      const text = JSON.stringify(await catalog());
      expect(text).not.toMatch(/уровень|бронз|серебр|золот|level|bronze|silver|gold/i);
      expect(keysDeep(await catalog())).not.toContain('level');
    });

    it('FR-REW-14: no ranking or leaderboard door exists', async () => {
      for (const url of ['/v1/leaderboard', '/v1/rankings', '/v1/badges/leaders', '/v1/users/awards']) {
        expect((await world.as(viewer).get(url)).statusCode, url).toBe(404);
      }
    });

    it('FR-AUTH-03: without a session -> 401', async () => {
      expectProblem('listBadges', await world.anonymous().get('/v1/badges'), 401, 'UNAUTHENTICATED');
    });
  });

  describe('getUserCounters (FR-REW-04, FR-PROF-06)', () => {
    it('FR-REW-04: a user without credited projects has zero counters', async () => {
      const user = await githubUser(world, 'no-credits');
      expect(await countersOk(world, viewer, user.id)).toEqual({ total: 0, byRole: [], productTypes: [] });
    });

    it('FR-REW-04: the counters of planted history: the total, one value per role, the product types', async () => {
      const user = await githubUser(world, 'counters');
      await plantHistory(world, user, [
        { roles: ['backend', 'qa'], completedDaysAgo: 40 },
        { roles: ['backend'], completedDaysAgo: 30, productType: 'ml_service' },
      ]);
      const counters = await countersOk(world, viewer, user.id);
      expect(counters.total).toBe(2);
      expect([...counters.byRole].sort((a, b) => a.roleCode.localeCompare(b.roleCode))).toEqual([
        { roleCode: 'backend', value: 2 },
        { roleCode: 'qa', value: 1 },
      ]);
      expect([...counters.productTypes].sort()).toEqual(['ml_service', 'web_service']);
    });

    it('FR-PROF-06: any signed-in user reads the counters of another one; a user can read his own', async () => {
      const user = await githubUser(world, 'counters-public');
      expect((await userCounters(world, viewer, user.id)).statusCode).toBe(200);
      expect((await userCounters(world, user, user.id)).statusCode).toBe(200);
    });

    it('FR-REW-04: a project without credit (denied) is not in the counters or the product types', async () => {
      const user = await githubUser(world, 'counters-denied');
      await plantHistory(world, user, [{ roles: ['backend'], completedDaysAgo: 20, status: 'denied' }]);
      expect(await countersOk(world, viewer, user.id)).toEqual({ total: 0, byRole: [], productTypes: [] });
    });

    it('FR-REW-04: an unknown user -> 404; a malformed id -> 400; no session -> 401', async () => {
      expectProblem('getUserCounters', await userCounters(world, viewer, NOWHERE), 404, 'NOT_FOUND');
      expectProblem('getUserCounters', await world.as(viewer).get('/v1/users/not-a-uuid/counters'), 400, 'VALIDATION_FAILED');
      expectProblem('getUserCounters', await world.anonymous().get(`/v1/users/${viewer.id}/counters`), 401, 'UNAUTHENTICATED');
    });

    it('FR-REW-15: the answer carries nothing of the anti-fraud machinery', async () => {
      const user = await githubUser(world, 'counters-hidden');
      await plantHistory(world, user, [{ roles: ['backend'], completedDaysAgo: 20 }]);
      expectNoFraudDetails(await userCounters(world, viewer, user.id));
    });
  });

  describe('listUserAwards (FR-REW-05, FR-REW-14, FR-PROF-06)', () => {
    it('FR-REW-05: a user without awards -> an empty list', async () => {
      const user = await githubUser(world, 'no-awards');
      expect(await awardsOk(world, viewer, user.id)).toEqual([]);
    });

    it('FR-REW-05: an award has the badge, the series and step, the project and the date; a revoked one is not returned', async () => {
      const user = await githubUser(world, 'awards');
      const t = await team(world, { members: 2, openSeats: 0 });
      const [badge] = await world.sql<{ code: string }[]>`
        SELECT code FROM rewards.badge_def WHERE name = 'Первый релиз'`;
      const [revokedBadge] = await world.sql<{ code: string }[]>`
        SELECT code FROM rewards.badge_def WHERE name = 'В срок'`;
      await world.sql`
        INSERT INTO rewards.award (id, user_id, badge_code, scope, team_id, awarded_at)
        VALUES (${randomUUID()}, ${user.id}, ${badge?.code ?? ''}, 'individual', ${t.id}, now())`;
      await world.sql`
        INSERT INTO rewards.award (id, user_id, badge_code, scope, team_id, awarded_at, revoked_at, revoke_reason)
        VALUES (${randomUUID()}, ${user.id}, ${revokedBadge?.code ?? ''}, 'individual', ${t.id}, now(), now(), 'violation')`;
      const awards = await awardsOk(world, viewer, user.id);
      expect(awards).toHaveLength(1);
      expect(awards[0]).toMatchObject({
        name: 'Первый релиз',
        series: 'projects',
        step: 1,
        teamId: t.id,
        teamName: t.dto.name,
      });
      expect(Number.isNaN(Date.parse(awards[0]?.awardedAt ?? ''))).toBe(false);
      expect(await activeAwardNames(world, user.id)).toEqual(['Первый релиз']);
    });

    it('FR-REW-14: the answer has no ranks, points, positions or comparisons with other users', async () => {
      const user = await githubUser(world, 'awards-flat');
      const [badge] = await world.sql<{ code: string }[]>`SELECT code FROM rewards.badge_def WHERE name = 'Первый релиз'`;
      await world.sql`
        INSERT INTO rewards.award (id, user_id, badge_code, scope, team_id, awarded_at)
        VALUES (${randomUUID()}, ${user.id}, ${badge?.code ?? ''}, 'individual', NULL, now())`;
      const response = await userAwards(world, viewer, user.id);
      const keys = keysDeep(response.json());
      for (const forbidden of ['rank', 'place', 'position', 'points', 'score', 'percentile', 'level']) {
        expect(keys).not.toContain(forbidden);
      }
      expectNoFraudDetails(response);
    });

    it('FR-REW-05: an unknown user -> 404; a malformed id -> 400; no session -> 401', async () => {
      expectProblem('listUserAwards', await userAwards(world, viewer, NOWHERE), 404, 'NOT_FOUND');
      expectProblem('listUserAwards', await world.as(viewer).get('/v1/users/x/awards'), 400, 'VALIDATION_FAILED');
      expectProblem('listUserAwards', await world.anonymous().get(`/v1/users/${viewer.id}/awards`), 401, 'UNAUTHENTICATED');
    });
  });

  describe('getTeamCredit before the project is completed (FR-REW-11)', () => {
    it('FR-REW-11: a participant of a team whose project is not completed -> 404 (no credit_run yet)', async () => {
      const t = await team(world, { members: 2, openSeats: 0 });
      expectProblem('getTeamCredit', await teamCredit(world, t.lead, t.id), 404, 'NOT_FOUND');
    });

    it('FR-REW-11: a malformed team id -> 400', async () => {
      expectProblem('getTeamCredit', await world.as(viewer).get('/v1/teams/nope/credit'), 400, 'VALIDATION_FAILED');
    });
  });
});
