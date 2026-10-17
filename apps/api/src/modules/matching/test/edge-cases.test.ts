import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { githubIdentity } from '../../../../test/fakes/github-server.js';
import { countOf } from '../../../../test/fixtures/assertions.js';
import type { UserFixture } from '../../../../test/fixtures/index.js';
import {
  activeApplications,
  applicationRow,
  applicationsOf,
  autoAddOutcomes,
  membershipRow,
} from '../../../../test/fixtures/matching-db.js';
import {
  applicationBody,
  autoAddedMember,
  candidate,
  freshRole,
  runAutoAdd,
  searchApplication,
  teamWithDemand,
  waitFulfilled,
  type CandidateRecommendationDto,
  type Page,
  type RoleDemandDto,
  type TeamRecommendationDto,
} from '../../../../test/fixtures/matching.js';
import { insertProfile } from '../../../../test/fixtures/profiles.js';
import {
  expectOk,
  joinThroughOffer,
  seatInput,
  team,
  type SeatDto,
} from '../../../../test/fixtures/teams.js';
import { activeMembershipsOf, seatStatus } from '../../../../test/fixtures/teams-db.js';
import type { World } from '../../../../test/fixtures/world.js';
import { FakeClock } from '../../../../test/helpers/clock.js';
import { describeInfra, waitFor } from '../../../../test/helpers/infra.js';
import { startWorld } from './support.js';

/*
 * S4-09: edge cases of the matching slice (docs/plan.md, S4-09). Same isolation rule as the other
 * suites of the slice: every test works with its own role codes (`freshRole`), so the background
 * `matching-auto-add` of the world never mixes the applications and seats of two tests.
 */

const HOUR = 3_600_000;
const SECOND = 1_000;
const WAIT = 30_000;
/** Time for a background run (5 s after the event) to act, when the test expects NOTHING to happen. */
const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 7_000));

const MY_APPLICATION = '/v1/me/search-application';

// every test builds teams, people and waits for background jobs: more than the default 30 s
vi.setConfig({ testTimeout: 120_000 });

describeInfra(
  'S4 matching edge cases: seats, GitHub, limits, order (FR-MATCH-05..08)',
  ['db', 'redis'],
  () => {
    let world: World;
    const clock = new FakeClock(Date.now());

    beforeAll(async () => {
      world = await startWorld({ clock });
    });

    afterAll(async () => {
      if (!world) return;
      await world.close();
    });

    const waitRestored = (user: UserFixture): Promise<unknown> =>
      waitFor(
        async () => {
          const response = await world.as(user).get(MY_APPLICATION);
          return response.statusCode === 200 ? response.json() : false;
        },
        WAIT,
        100,
      );

    describe('the seat is closed before the add', () => {
      it('the only seat is closed: nobody is added, the application stays active and is added to a seat that opens later', async () => {
        const role = await freshRole(world);
        const f = await teamWithDemand(world, { roleCode: role, openSeats: 1 });
        const seat = f.openSeats[0];
        if (!seat) throw new Error('no seat');
        const queued = await searchApplication(world, { roles: [role], label: 'closed-only' });
        expect((await world.as(f.lead).delete(`/v1/teams/${f.id}/seats/${seat.id}`)).statusCode).toBe(
          204,
        );
        await runAutoAdd(world);
        expect(await seatStatus(world, seat.id)).toBe('closed');
        expect((await applicationRow(world, queued.application.id)).status).toBe('active');
        expect(await membershipRow(world, f.id, queued.user.id)).toBeUndefined();
        expect(
          (await autoAddOutcomes(world, queued.application.id)).filter(
            (o) => o.seat_id === seat.id && o.outcome === 'added',
          ),
        ).toEqual([]);

        const added = expectOk<{ items: SeatDto[] }>(
          'addSeats',
          await world.as(f.lead).post(`/v1/teams/${f.id}/seats`, {
            seats: [seatInput({ roleCode: role })],
          }),
          201,
        );
        const fresh = added.items[0];
        if (!fresh) throw new Error('no new seat');
        await runAutoAdd(world);
        await waitFulfilled(world, queued.application.id);
        expect(await applicationRow(world, queued.application.id)).toMatchObject({
          fulfilled_seat_id: fresh.id,
          fulfilled_team_id: f.id,
        });
        expect(await seatStatus(world, seat.id)).toBe('closed');
      });
    });

    describe('an application of a person without GitHub (FR-AUTH-05, FR-MATCH-07)', () => {
      it('the earliest application lost its GitHub: it is skipped with GITHUB_REQUIRED, the next one gets the seat, the skipped one stays active and is added once GitHub is linked again', async () => {
        const role = await freshRole(world);
        const first = await searchApplication(world, { roles: [role], label: 'gh-first' });
        clock.advance(SECOND);
        const second = await searchApplication(world, { roles: [role], label: 'gh-second' });
        clock.advance(SECOND);
        const third = await searchApplication(world, { roles: [role], label: 'gh-third' });
        const [linked] = await world.sql<{ id: string; login: string }[]>`
          SELECT github_user_id::text AS id, github_login AS login FROM auth."user" WHERE id = ${first.user.id}`;
        if (!linked) throw new Error('no user row');
        await world.sql`
          UPDATE auth."user" SET github_user_id = NULL, github_login = NULL WHERE id = ${first.user.id}`;

        const f = await teamWithDemand(world, { roleCode: role, openSeats: 1 });
        await runAutoAdd(world);
        await waitFulfilled(world, second.application.id);
        expect((await applicationRow(world, first.application.id)).status).toBe('active');
        expect((await applicationRow(world, third.application.id)).status).toBe('active');
        expect(await membershipRow(world, f.id, first.user.id)).toBeUndefined();
        expect(await autoAddOutcomes(world, first.application.id)).toContainEqual(
          expect.objectContaining({ outcome: 'skipped', reason: 'GITHUB_REQUIRED' }),
        );

        await world.sql`
          UPDATE auth."user" SET github_user_id = ${linked.id}::bigint, github_login = ${linked.login}
           WHERE id = ${first.user.id}`;
        const next = await teamWithDemand(world, { roleCode: role, openSeats: 1 });
        await runAutoAdd(world);
        await waitFulfilled(world, first.application.id);
        expect((await applicationRow(world, first.application.id)).fulfilled_team_id).toBe(next.id);
        expect((await applicationRow(world, third.application.id)).status).toBe('active');
      });

      it('a person who never linked GitHub cannot stand in the queue at all: no application row appears', async () => {
        const role = await freshRole(world);
        const person = await candidate(world, 'never-github', { roles: [role], github: false });
        const response = await world.as(person).post(MY_APPLICATION, applicationBody([role]));
        expect(response.statusCode, response.body).toBe(409);
        expect(response.json<{ code: string }>().code).toBe('GITHUB_REQUIRED');
        expect(await applicationsOf(world, person.id)).toEqual([]);
        const f = await teamWithDemand(world, { roleCode: role, openSeats: 1 });
        await runAutoAdd(world);
        expect(await seatStatus(world, f.openSeats[0]?.id ?? '')).toBe('open');
      });
    });

    describe('the project limit (C-10, FR-MATCH-07)', () => {
      it('the earliest application belongs to a person with 2 active projects: it is skipped (PROJECT_LIMIT), stays active, the next person gets the seat', async () => {
        const role = await freshRole(world);
        const limited = await candidate(world, 'limit-first', { roles: [role] });
        for (let i = 0; i < 2; i += 1) {
          const t = await team(world, { openSeats: 1 });
          const seat = t.openSeats[0];
          if (!seat) throw new Error('no seat');
          await joinThroughOffer(world, t.lead, t.id, seat.id, limited);
        }
        expect(await activeMembershipsOf(world, limited.id)).toBe(2);
        const first = await searchApplication(world, { roles: [role], user: limited });
        clock.advance(SECOND);
        const second = await searchApplication(world, { roles: [role], label: 'limit-second' });
        const f = await teamWithDemand(world, { roleCode: role, openSeats: 1 });
        await runAutoAdd(world);
        await waitFulfilled(world, second.application.id);
        expect(await membershipRow(world, f.id, limited.id)).toBeUndefined();
        expect((await applicationRow(world, first.application.id)).status).toBe('active');
        expect(await autoAddOutcomes(world, first.application.id)).toContainEqual(
          expect.objectContaining({ outcome: 'skipped', reason: 'PROJECT_LIMIT' }),
        );
        expect(await activeMembershipsOf(world, limited.id)).toBe(2);
      });
    });

    describe('priority of two roles that match in the same window (FR-MATCH-06)', () => {
      it('the role with the smaller priority number wins even when the seat of the other role scores much higher', async () => {
        const [a, b] = [await freshRole(world), await freshRole(world)];
        const person = await candidate(world, 'prio-score', {
          roles: [a, b],
          level: 'junior',
          stack: ['typescript'],
        });
        // seat A: no stack match (score 0.55, still over the threshold 0.5); seat B: full match (0.9)
        const ta = await teamWithDemand(world, {
          roleCode: a,
          openSeats: 1,
          seat: { stack: ['react', 'postgresql'] },
        });
        const tb = await teamWithDemand(world, { roleCode: b, openSeats: 1 });
        // the premise (checked before the person queues, or the background run would take him): B really is the better pair
        const recommended = await waitFor(
          async () => {
            const page = expectOk<Page<TeamRecommendationDto>>(
              'listRecommendedTeams',
              await world.as(person).get('/v1/me/recommended-teams?limit=100'),
              200,
            );
            const forA = page.items.find((i) => i.teamId === ta.id);
            const forB = page.items.find((i) => i.teamId === tb.id);
            return forA && forB ? { forA, forB } : false;
          },
          WAIT,
          250,
        );
        expect(recommended.forA.score).toBeGreaterThanOrEqual(0.5);
        expect(recommended.forB.score).toBeGreaterThan(recommended.forA.score);

        const queued = await searchApplication(world, { roles: [a, b], user: person });
        await runAutoAdd(world);
        await waitFulfilled(world, queued.application.id);
        expect(await applicationRow(world, queued.application.id)).toMatchObject({
          fulfilled_role_code: a,
          fulfilled_team_id: ta.id,
        });
        expect(await seatStatus(world, tb.openSeats[0]?.id ?? '')).toBe('open');
      });
    });

    describe('fairness of the queue by enqueued_at (architecture 6.4 step 3)', () => {
      it('20 people, seats open one by one: the seats go to the 1st, the 2nd and the 3rd in line, everybody else stays active', async () => {
        const role = await freshRole(world);
        const line = [];
        for (let i = 0; i < 20; i += 1) {
          line.push(await searchApplication(world, { roles: [role], label: `line-${i}` }));
          clock.advance(SECOND);
        }
        for (let turn = 0; turn < 3; turn += 1) {
          const f = await teamWithDemand(world, { roleCode: role, openSeats: 1 });
          const winner = line[turn];
          if (!winner) throw new Error('no winner');
          await runAutoAdd(world);
          await waitFulfilled(world, winner.application.id);
          expect((await applicationRow(world, winner.application.id)).fulfilled_team_id).toBe(f.id);
          for (const [index, other] of line.entries()) {
            if (index <= turn) continue;
            expect((await applicationRow(world, other.application.id)).status).toBe('active');
          }
        }
        for (const [index, entry] of line.entries()) {
          const row = await applicationRow(world, entry.application.id);
          expect(row.status, `person #${index}`).toBe(index < 3 ? 'fulfilled' : 'active');
        }
      });
    });

    describe('exclusion from the trial (FR-MATCH-08, FR-TEAM-22)', () => {
      it('an excluded person is not auto-added to that team again, not even to a NEW seat of it, and is neither recommended that team nor listed as its candidate', async () => {
        const f = await autoAddedMember(world, { extraOpenSeats: 1 });
        const bystander = await candidate(world, 'bystander', {
          roles: [f.roleCode],
          level: 'junior',
          stack: ['typescript'],
        });
        expectOk(
          'excludeTrialMember',
          await world.as(f.lead).delete(`/v1/teams/${f.id}/members/${f.member.id}`),
          204,
        );
        await waitRestored(f.member);
        const added = expectOk<{ items: SeatDto[] }>(
          'addSeats',
          await world.as(f.lead).post(`/v1/teams/${f.id}/seats`, {
            seats: [seatInput({ roleCode: f.roleCode })],
          }),
          201,
        );
        expect(added.items).toHaveLength(1);
        await runAutoAdd(world);
        await runAutoAdd(world);
        await settle();
        expect((await applicationRow(world, f.application.id)).status).toBe('active');
        expect(await membershipRow(world, f.id, f.member.id)).toMatchObject({ status: 'removed' });
        expect(await activeMembershipsOf(world, f.member.id)).toBe(0);

        // a positive anchor first: another team and another person show up in the lists, then the
        // absence of the excluding team / the excluded person means something. The other team's seat
        // scores under the auto-add threshold for the member (his time zone is two hours away, no
        // stack match, one level above the minimum), so that the background run leaves him in the
        // queue and the team stays a plain recommendation.
        await world.sql`
          UPDATE profiles.profile SET timezone = 'Asia/Yekaterinburg' WHERE user_id = ${f.member.id}`;
        const other = await teamWithDemand(world, {
          roleCode: f.roleCode,
          openSeats: 1,
          seat: { stack: ['react', 'postgresql'], minLevel: 'beginner' },
        });
        const teams = await waitFor(
          async () => {
            const page = expectOk<Page<TeamRecommendationDto>>(
              'listRecommendedTeams',
              await world.as(f.member).get('/v1/me/recommended-teams?limit=100'),
              200,
            );
            return page.items.some((i) => i.teamId === other.id) ? page.items : false;
          },
          WAIT,
          250,
        );
        expect(teams.find((i) => i.teamId === other.id)?.score).toBeLessThan(0.5);
        expect(teams.map((i) => i.teamId)).not.toContain(f.id);
        const seatId = f.seat.id;
        const candidates = await waitFor(
          async () => {
            const page = expectOk<Page<CandidateRecommendationDto>>(
              'listSeatCandidates',
              await world
                .as(f.lead)
                .get(`/v1/teams/${f.id}/seats/${seatId}/candidates?limit=100`),
              200,
            );
            return page.items.some((i) => i.userId === bystander.id) ? page.items : false;
          },
          WAIT,
          250,
        );
        expect(candidates.map((i) => i.userId)).not.toContain(f.member.id);
      });

      it('a person who is a member of a team is not recommended that team, even for another open seat of his role', async () => {
        const role = await freshRole(world);
        const person = await candidate(world, 'member-not-recommended', {
          roles: [role],
          level: 'junior',
          stack: ['typescript'],
        });
        const mine = await team(world, { roleCode: role, openSeats: 2 });
        const [first] = mine.openSeats;
        if (!first) throw new Error('no seat');
        await joinThroughOffer(world, mine.lead, mine.id, first.id, person);
        const other = await teamWithDemand(world, { roleCode: role, openSeats: 1 });
        const teams = await waitFor(
          async () => {
            const page = expectOk<Page<TeamRecommendationDto>>(
              'listRecommendedTeams',
              await world.as(person).get('/v1/me/recommended-teams?limit=100'),
              200,
            );
            return page.items.some((i) => i.teamId === other.id) ? page.items : false;
          },
          WAIT,
          250,
        );
        expect(teams.map((i) => i.teamId)).not.toContain(mine.id);
      });

      it('a returned member keeps the early place in the queue: with one seat and two people waiting, the returned one (enqueued earlier) wins over the one who queued while he was in the team', async () => {
        const [roleR, roleQ] = [await freshRole(world), await freshRole(world)];
        const a = await candidate(world, 'returned-a', { roles: [roleR, roleQ] });
        const first = await teamWithDemand(world, { roleCode: roleR, openSeats: 1 });
        const early = await searchApplication(world, { roles: [roleR, roleQ], user: a });
        await runAutoAdd(world);
        await waitFulfilled(world, early.application.id);
        clock.advance(HOUR);
        const later = await searchApplication(world, { roles: [roleQ], label: 'returned-c' });
        clock.advance(HOUR);
        expectOk(
          'excludeTrialMember',
          await world.as(first.lead).delete(`/v1/teams/${first.id}/members/${a.id}`),
          204,
        );
        await waitRestored(a);
        const restored = await applicationRow(world, early.application.id);
        expect(restored.status).toBe('active');
        expect(restored.enqueued_at.getTime()).toBe(Date.parse(early.application.enqueuedAt));
        expect(restored.enqueued_at.getTime()).toBeLessThan(
          (await applicationRow(world, later.application.id)).enqueued_at.getTime(),
        );

        const contested = await teamWithDemand(world, { roleCode: roleQ, openSeats: 1 });
        await runAutoAdd(world);
        await waitFulfilled(world, early.application.id);
        expect((await applicationRow(world, early.application.id)).fulfilled_team_id).toBe(
          contested.id,
        );
        expect((await applicationRow(world, later.application.id)).status).toBe('active');
      });
    });

    describe('the candidate list does not leak the profile (SEC-11, FR-MATCH-01)', () => {
      it('listSeatCandidates shows the display name, the score and the matched tags only: no free texts, links, experience, hours, level, unmatched stack, e-mail or GitHub', async () => {
        const role = await freshRole(world);
        const person = await candidate(world, 'leaky-profile', {
          roles: [role],
          level: 'junior',
          stack: ['typescript', 'react', 'postgresql'],
          hoursPerWeek: 17,
          profile: {
            displayName: 'Visible Name',
            portfolioUrl: 'https://hidden-portfolio.example.test/me',
            strengths: ['HIDDEN-STRENGTH'],
            weaknesses: ['HIDDEN-WEAKNESS'],
            experience: [
              { title: 'HIDDEN-JOB-TITLE', description: 'HIDDEN-JOB-TEXT', from: '2023-01-01', to: null },
            ],
          },
        });
        const f = await teamWithDemand(world, {
          roleCode: role,
          openSeats: 1,
          seat: { stack: ['typescript'] },
        });
        const seatId = f.openSeats[0]?.id ?? '';
        const response = await waitFor(
          async () => {
            const r = await world
              .as(f.lead)
              .get(`/v1/teams/${f.id}/seats/${seatId}/candidates?limit=100`);
            return r.statusCode === 200 && r.json<Page<unknown>>().items.length > 0 ? r : false;
          },
          WAIT,
          250,
        );
        const page = response.json<Page<Record<string, unknown>>>();
        const item = page.items.find((i) => i['userId'] === person.id);
        expect(item).toBeDefined();
        expect(item?.['displayName']).toBe('Visible Name');
        const reasons = item?.['reasons'] as Record<string, unknown>;
        expect(Object.keys(reasons).sort()).toEqual(
          [
            'availability',
            'completedProjects',
            'level',
            'matchedStackTags',
            'role',
            'stack',
            'timezone',
            'timezoneDiffHours',
          ].sort(),
        );
        expect(reasons['matchedStackTags']).toEqual(['typescript']);
        for (const secret of [
          'HIDDEN-STRENGTH',
          'HIDDEN-WEAKNESS',
          'HIDDEN-JOB',
          'hidden-portfolio',
          'postgresql',
          'react',
          person.email,
          'githubLogin',
          'gh-',
          '"hoursPerWeek"',
          '"rolePrefs"',
          '"experience"',
          '"stack":[',
        ]) {
          expect(response.body, `leaked: ${secret}`).not.toContain(secret);
        }
      });
    });

    describe('the demand cache after a seat opens or closes (C-39, FR-MATCH-09)', () => {
      it('a read is cached (same computedAt); seats added to the team and then closed move the numbers within seconds, not after the TTL', async () => {
        const role = await freshRole(world);
        const viewer = await candidate(world, 'cache-viewer', { roles: [] });
        const f = await team(world, { roleCode: role, openSeats: 1 });
        const demand = async (): Promise<RoleDemandDto | undefined> =>
          expectOk<{ items: RoleDemandDto[] }>(
            'getRoleDemand',
            await world.as(viewer).get(`/v1/demand?roles=${role}`),
            200,
          ).items[0];

        const warm = await waitFor(
          async () => {
            const row = await demand();
            return row?.openSeats === 1 ? row : false;
          },
          WAIT,
          250,
        );
        expect((await demand())?.computedAt).toBe(warm.computedAt);

        clock.advance(SECOND);
        const added = expectOk<{ items: SeatDto[] }>(
          'addSeats',
          await world.as(f.lead).post(`/v1/teams/${f.id}/seats`, {
            seats: [seatInput({ roleCode: role, count: 2 })],
          }),
          201,
        );
        const opened = await waitFor(
          async () => {
            const row = await demand();
            return row?.openSeats === 3 ? row : false;
          },
          25_000,
          250,
        );
        expect(opened.teamsSeeking).toBe(1);
        expect(opened.computedAt).not.toBe(warm.computedAt);

        const [closing] = added.items;
        if (!closing) throw new Error('no added seat');
        expect(
          (await world.as(f.lead).delete(`/v1/teams/${f.id}/seats/${closing.id}`)).statusCode,
        ).toBe(204);
        const closed = await waitFor(
          async () => {
            const row = await demand();
            return row?.openSeats === 2 ? row : false;
          },
          25_000,
          250,
        );
        expect(closed.deficit).toBe(true);
      });
    });
  },
);

describeInfra(
  'S4 matching edge cases: account deletion of a queued candidate (FR-AUTH-09, architecture 13.9)',
  ['db', 'redis'],
  () => {
    let world: World;
    const clock = new FakeClock(Date.now());

    beforeAll(async () => {
      world = await startWorld({ clock });
    });

    afterAll(async () => {
      if (!world) return;
      await world.close();
    });

    const setStatus = (userId: string, status: 'active' | 'deleting'): Promise<unknown> =>
      world.sql`UPDATE auth."user" SET status = ${status} WHERE id = ${userId}`;

    it('FR-AUTH-09 (grace period): a person whose account is "deleting" is skipped (USER_INACTIVE) and stays in the queue; if the deletion is cancelled the next run adds him', async () => {
      const role = await freshRole(world);
      const queued = await searchApplication(world, { roles: [role], label: 'deleting-grace' });
      await setStatus(queued.user.id, 'deleting');
      const f = await teamWithDemand(world, { roleCode: role, openSeats: 1 });
      await runAutoAdd(world);
      expect(await seatStatus(world, f.openSeats[0]?.id ?? '')).toBe('open');
      expect((await applicationRow(world, queued.application.id)).status).toBe('active');
      expect(await autoAddOutcomes(world, queued.application.id)).toContainEqual(
        expect.objectContaining({ outcome: 'skipped', reason: 'USER_INACTIVE' }),
      );

      await setStatus(queued.user.id, 'active');
      await runAutoAdd(world);
      await waitFulfilled(world, queued.application.id);
      expect((await membershipRow(world, f.id, queued.user.id))?.status).toBe('active');
    });

    describe('the saga has erased the account of a queued candidate', () => {
      let roleQueued = '';
      let userId = '';
      let applicationId = '';

      beforeAll(async () => {
        // the person wants roleQueued in the queue and has roleSeat in the profile, so that a seat of
        // roleSeat produces a `match_candidate` row (a recommendation) for him
        roleQueued = await freshRole(world);
        const roleSeat = await freshRole(world);
        const { user, session } = await world.signedIn('queued-then-deleted');
        userId = user.id;
        const identity = githubIdentity(`del-${world.runId}`);
        await world.sql`
          UPDATE auth."user" SET github_user_id = ${identity.id}, github_login = ${identity.login}
           WHERE id = ${user.id}`;
        await insertProfile(world.sql, user.id, {
          displayName: 'Queued Then Deleted',
          rolePrefs: [
            { roleCode: roleSeat, level: 'junior' },
            { roleCode: roleQueued, level: 'junior' },
          ],
          stack: ['typescript'],
          hoursPerWeek: 12,
        });
        const created = await session.post(MY_APPLICATION, applicationBody([roleQueued]));
        expect(created.statusCode, created.body).toBe(201);
        applicationId = created.json<{ id: string }>().id;
        const seatTeam = await teamWithDemand(world, {
          roleCode: roleSeat,
          openSeats: 1,
        });
        await waitFor(
          async () =>
            (await countOf(world.sql<{ n: number }[]>`
              SELECT count(*)::int AS n FROM matching.match_candidate
               WHERE user_id = ${user.id} AND team_id = ${seatTeam.id}`)) > 0,
          WAIT,
          250,
        );

        const requested = await session.post('/v1/me/deletion-requests', {
          reason: 'user_request',
          confirm: true,
        });
        expect(requested.statusCode, requested.body).toBe(202);
        clock.advance(72 * HOUR + 60_000);
        await world.runMaintenance('deletion-scheduler');
        await waitFor(async () => {
          const rows = await world.sql<{ status: string }[]>`
            SELECT status FROM auth.deletion_request WHERE user_id = ${user.id}`;
          return rows[0]?.status === 'completed';
        }, 60_000);
      }, 150_000);

      it('architecture 6.5 / 13.9: the application of the erased person is no longer active (cancelled)', async () => {
        expect(await activeApplications(world, userId)).toBe(0);
      });

      it('architecture 13.9: the rows of the person are removed - applications with roles and exclusions, match_candidate, candidate_stats', async () => {
        const counts = await world.sql<{ what: string; n: number }[]>`
          SELECT 'search_application' AS what, count(*)::int AS n
            FROM matching.search_application WHERE user_id = ${userId}
          UNION ALL SELECT 'application_role', count(*)::int
            FROM matching.application_role WHERE application_id = ${applicationId}
          UNION ALL SELECT 'match_candidate', count(*)::int
            FROM matching.match_candidate WHERE user_id = ${userId}
          UNION ALL SELECT 'candidate_stats', count(*)::int
            FROM matching.candidate_stats WHERE user_id = ${userId}`;
        expect(Object.fromEntries(counts.map((c) => [c.what, c.n]))).toEqual({
          search_application: 0,
          application_role: 0,
          match_candidate: 0,
          candidate_stats: 0,
        });
      });

      it('FR-MATCH-09: the erased person is not counted in the queue of the role any more', async () => {
        const viewer = await candidate(world, 'after-deletion-viewer', { roles: [] });
        const demand = expectOk<{ items: RoleDemandDto[] }>(
          'getRoleDemand',
          await world.as(viewer).get(`/v1/demand?roles=${roleQueued}`),
          200,
        ).items[0];
        expect(demand?.queuedCandidates).toBe(0);
      });

      it('FR-MATCH-07: a seat of the role that opens afterwards is not given to the erased person', async () => {
        const f = await teamWithDemand(world, { roleCode: roleQueued, openSeats: 1 });
        await runAutoAdd(world);
        await settle();
        expect(await seatStatus(world, f.openSeats[0]?.id ?? '')).toBe('open');
        expect(await membershipRow(world, f.id, userId)).toBeUndefined();
      });
    });
  },
);
