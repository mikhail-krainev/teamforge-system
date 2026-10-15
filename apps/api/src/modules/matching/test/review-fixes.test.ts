import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { countOf } from '../../../../test/fixtures/assertions.js';
import type { UserFixture } from '../../../../test/fixtures/index.js';
import {
  applicationRow,
  assignmentDeficit,
  exclusionTeams,
  membershipRow,
  waitSamples,
} from '../../../../test/fixtures/matching-db.js';
import {
  applicationBody,
  autoAddedMember,
  candidate,
  DAY,
  freshRole,
  runAutoAdd,
  searchApplication,
  teamWithDemand,
  waitFulfilled,
  type AutoAddedMember,
  type Page,
  type SearchApplicationDto,
  type TeamRecommendationDto,
} from '../../../../test/fixtures/matching.js';
import { expectOk, joinThroughOffer } from '../../../../test/fixtures/teams.js';
import { seatStatus } from '../../../../test/fixtures/teams-db.js';
import type { World } from '../../../../test/fixtures/world.js';
import { FakeClock } from '../../../../test/helpers/clock.js';
import { describeInfra, waitFor } from '../../../../test/helpers/infra.js';
import { startWorld } from './support.js';

/*
 * Findings of the review/audit of slice 4: exclusions per person (FR-MATCH-08), the pause of a
 * carried-over application (Р-15), the deficit of the last seat (FR-TEAM-25), the deletion saga
 * (architecture 13.9).
 */

const HOUR = 3_600_000;
const WAIT = 30_000;
const MY_APPLICATION = '/v1/me/search-application';

vi.setConfig({ testTimeout: 120_000 });

describeInfra('S4 matching: review fixes', ['db', 'redis'], () => {
  let world: World;
  const clock = new FakeClock(Date.now());

  beforeAll(async () => {
    world = await startWorld({ clock });
  });

  afterAll(async () => {
    if (!world) return;
    await world.close();
  });

  const exclude = (f: AutoAddedMember) =>
    world.as(f.lead).delete(`/v1/teams/${f.id}/members/${f.member.id}`);
  const waitRestored = (user: UserFixture): Promise<SearchApplicationDto> =>
    waitFor(
      async () => {
        const response = await world.as(user).get(MY_APPLICATION);
        return response.statusCode === 200 ? response.json<SearchApplicationDto>() : false;
      },
      WAIT,
      100,
    );

  describe('exclusion is kept per person, not per application (FR-MATCH-08)', () => {
    it('excluded -> cancel -> new application: the auto-add does not put the person into the excluding team again', async () => {
      const f = await autoAddedMember(world);
      expectOk('excludeTrialMember', await exclude(f), 204);
      await waitRestored(f.member);
      expectOk('cancelSearchApplication', await world.as(f.member).delete(MY_APPLICATION), 204);
      // the excluding team's seat is the oldest open seat of the role, so it would be tried first
      const other = await teamWithDemand(world, { roleCode: f.roleCode, openSeats: 1 });
      const again = expectOk<SearchApplicationDto>(
        'createSearchApplication',
        await world.as(f.member).post(MY_APPLICATION, applicationBody([f.roleCode])),
        201,
      );
      await runAutoAdd(world);
      await waitFulfilled(world, again.id);
      expect((await applicationRow(world, again.id)).fulfilled_team_id).toBe(other.id);
      expect(await seatStatus(world, f.seat.id)).toBe('open');
      expect((await membershipRow(world, f.id, f.member.id))?.status).toBe('removed');
    });

    it('excluded -> cancel: the excluding team is not recommended to the person, other teams are', async () => {
      const f = await autoAddedMember(world);
      expectOk('excludeTrialMember', await exclude(f), 204);
      await waitRestored(f.member);
      expectOk('cancelSearchApplication', await world.as(f.member).delete(MY_APPLICATION), 204);
      const control = await teamWithDemand(world, { roleCode: f.roleCode, openSeats: 1 });
      const teams = await waitFor(
        async () => {
          const page = expectOk<Page<TeamRecommendationDto>>(
            'listRecommendedTeams',
            await world.as(f.member).get('/v1/me/recommended-teams?limit=100'),
            200,
          );
          return page.items.some((item) => item.teamId === control.id) ? page.items : false;
        },
        WAIT,
        250,
      );
      expect(teams.map((item) => item.teamId)).not.toContain(f.id);
    });
  });

  describe('a carried-over application keeps the pause (Р-15, FR-MATCH-08)', () => {
    it('the old pause and the time in the team move to the new application: the closed wait does not include them', async () => {
      const f = await autoAddedMember(world);
      clock.advance(HOUR);
      const second = expectOk<SearchApplicationDto>(
        'createSearchApplication',
        await world.as(f.member).post(MY_APPLICATION, applicationBody([f.roleCode])),
        201,
      );
      clock.advance(2 * DAY);
      expectOk('excludeTrialMember', await exclude(f), 204);
      await waitFor(async () => (await exclusionTeams(world, second.id)).length > 0, WAIT);
      // in the team from the auto-add to the exclusion: 1 h + 2 days
      const paused = (await applicationRow(world, second.id)).paused_seconds;
      expect(paused).toBeGreaterThanOrEqual(2 * 86_400 + 3_600 - 60);
      expect(paused).toBeLessThanOrEqual(2 * 86_400 + 3_600 + 600);
      clock.advance(HOUR);
      await teamWithDemand(world, { roleCode: f.roleCode, openSeats: 1 });
      await runAutoAdd(world);
      await waitFulfilled(world, second.id);
      const [sample] = await waitSamples(world, second.id);
      // only the hour after the return counts as waiting
      expect(sample?.waited_seconds).toBeGreaterThanOrEqual(3_600 - 60);
      expect(sample?.waited_seconds).toBeLessThanOrEqual(3_600 + 600);
    });
  });

  describe('deficit of the last seat (FR-TEAM-25, FR-MATCH-11)', () => {
    it('a join that fills the team to 8 still counts its seat as open: 1 open vs 0 queued -> deficit', async () => {
      const role = await freshRole(world);
      const f = await teamWithDemand(world, { roleCode: role, members: 7, openSeats: 1 });
      const joiner = await candidate(world, 'deficit-last-seat', { roles: [] });
      const seat = f.openSeats[0];
      if (!seat) throw new Error('no seat');
      await joinThroughOffer(world, f.lead, f.id, seat.id, joiner);
      expect(await assignmentDeficit(world, seat.id)).toEqual({
        deficit_at_join: true,
        deficit_open_seats: 1,
        deficit_queued: 0,
      });
    });
  });

  describe('personal data deletion (architecture 13.9)', () => {
    it('the matching step erases applications, recommendations and statistics of the person, and nobody else', async () => {
      const role = await freshRole(world);
      const gone = await searchApplication(world, { roles: [role], label: 'erase-me' });
      const kept = await searchApplication(world, { roles: [role], label: 'keep-me' });
      const teamId = randomUUID();
      for (const userId of [gone.user.id, kept.user.id]) {
        await world.sql`
          INSERT INTO matching.candidate_stats (user_id, role_code, completed_count)
          VALUES (${userId}, ${role}, 2)`;
        await world.sql`
          INSERT INTO matching.match_candidate
            (seat_id, user_id, team_id, role_code, score, reasons, in_queue, computed_at)
          VALUES (${randomUUID()}, ${userId}, ${teamId}, ${role}, 0.800, '{}'::jsonb, true, now())`;
      }
      await world.sql`
        INSERT INTO matching.application_exclusion (application_id, team_id)
        VALUES (${gone.application.id}, ${teamId})`;

      const requested = await world
        .as(gone.user)
        .post('/v1/me/deletion-requests', { reason: 'user_request', confirm: true });
      expect(requested.statusCode).toBe(202);
      clock.advance(72 * HOUR + 60_000);
      await world.runMaintenance('deletion-scheduler');
      await waitFor(async () => {
        const rows = await world.sql<{ status: string }[]>`
          SELECT status FROM auth.deletion_request WHERE user_id = ${gone.user.id}`;
        return rows[0]?.status === 'completed';
      }, WAIT);

      const count = (table: string, column: string, id: string): Promise<number> =>
        countOf(
          world.sql<{ n: number }[]>`
            SELECT count(*)::int AS n FROM ${world.sql(`matching.${table}`)}
             WHERE ${world.sql(column)} = ${id}`,
        );
      expect(await count('search_application', 'user_id', gone.user.id)).toBe(0);
      expect(await count('application_role', 'application_id', gone.application.id)).toBe(0);
      expect(await count('application_exclusion', 'application_id', gone.application.id)).toBe(0);
      expect(await count('match_candidate', 'user_id', gone.user.id)).toBe(0);
      expect(await count('candidate_stats', 'user_id', gone.user.id)).toBe(0);
      expect(await count('search_application', 'user_id', kept.user.id)).toBe(1);
      expect(await count('match_candidate', 'user_id', kept.user.id)).toBe(1);
      expect(await count('candidate_stats', 'user_id', kept.user.id)).toBe(1);
      const steps = await world.sql<{ module: string }[]>`
        SELECT module FROM auth.deletion_step
         WHERE request_id IN (SELECT id FROM auth.deletion_request WHERE user_id = ${gone.user.id})`;
      expect(steps.map((step) => step.module)).toContain('matching');
    });
  });
});
