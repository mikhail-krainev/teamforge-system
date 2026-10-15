import { afterAll, beforeAll, expect, it } from 'vitest';
import { expectProblem } from '../../../../test/fixtures/assertions.js';
import type { UserFixture } from '../../../../test/fixtures/index.js';
import {
  candidate,
  freshRole,
  queryCounter,
  searchApplication,
  teamWithDemand,
  type CandidateRecommendationDto,
  type CandidateOptions,
  type Page,
  type TeamRecommendationDto,
  type TeamWithDemand,
} from '../../../../test/fixtures/matching.js';
import { profileInput } from '../../../../test/fixtures/profiles.js';
import { expectOk, type TeamFixture } from '../../../../test/fixtures/teams.js';
import { World } from '../../../../test/fixtures/world.js';
import { describeInfra, waitFor } from '../../../../test/helpers/infra.js';

/*
 * Recommendations are read from the precomputed `match_candidate` table (FR-MATCH-01, FR-MATCH-02),
 * filled by the `matching-recompute` job 5 s after the events (architecture 6.3). Every read below
 * therefore waits for the table with `waitFor`; candidates are created BEFORE the team, so that the
 * `teams.seat_opened` of the team creation finds them.
 */

const WAIT = 30_000;
const GOOD: CandidateOptions = { level: 'junior', hoursPerWeek: 12, stack: ['typescript'] };

const seatCandidatesUrl = (teamId: string, seatId: string, query = ''): string =>
  `/v1/teams/${teamId}/seats/${seatId}/candidates${query}`;

describeInfra(
  'S4 matching: recommended candidates for a seat (FR-MATCH-01, FR-MATCH-12)',
  ['db', 'redis'],
  () => {
    let world: World;

    beforeAll(async () => {
      world = await World.start();
      await world.ensureCatalog(['backend', 'frontend', 'pm', 'designer', 'qa', 'devops']);
    });

    afterAll(async () => {
      if (!world) return;
      await world.close();
    });

    const candidatesOf = async (
      lead: UserFixture,
      team: TeamFixture,
      query = '',
    ): Promise<Page<CandidateRecommendationDto>> =>
      expectOk<Page<CandidateRecommendationDto>>(
        'listSeatCandidates',
        await world.as(lead).get(seatCandidatesUrl(team.id, team.openSeats[0]?.id ?? '', query)),
        200,
      );

    /** Waits for the recompute job to publish at least `count` rows for the seat. */
    const readyCandidates = async (
      f: TeamWithDemand,
      count: number,
    ): Promise<CandidateRecommendationDto[]> =>
      waitFor(
        async () => {
          const page = await candidatesOf(f.lead, f, '?limit=100');
          return page.items.length >= count ? page.items : false;
        },
        WAIT,
        250,
      );

    it('FR-MATCH-01, FR-MATCH-12: candidates that pass the hard filters, best score first, with the reasons (contract schema)', async () => {
      const role = await freshRole(world);
      const best = await candidate(world, 'rec-best', { roles: [role], ...GOOD });
      const lower = await candidate(world, 'rec-lower', { roles: [role], ...GOOD, stack: [] });
      const f = await teamWithDemand(world, { roleCode: role, openSeats: 1 });
      const items = await readyCandidates(f, 2);
      expect(items.map((i) => i.userId)).toEqual([best.id, lower.id]);
      const [first, second] = items;
      expect(first?.score ?? 0).toBeGreaterThan(second?.score ?? 1);
      expect(first?.reasons).toMatchObject({
        role: true,
        stack: 1,
        matchedStackTags: ['typescript'],
      });
      expect(second?.reasons).toMatchObject({ role: true, stack: 0, matchedStackTags: [] });
      expect(first?.displayName).toBe('rec-best');
      expect(first?.inQueue).toBe(false);
    });

    it('FR-MATCH-12: the score is the weighted sum 0.35 stack + 0.20 level + 0.20 tz + 0.15 availability + 0.10 completed (C-44), rounded to 3 digits', async () => {
      const role = await freshRole(world);
      // seat: junior, 6 h, stack [typescript, react]; team: Europe/Moscow, 10 h per week
      // person: middle (one step above: 0.75), Europe/Samara (UTC+4, 1 h away: 1 - 1/6), 8 h (8/10),
      // stack [typescript] (1 of 2: 0.5), no completed projects (0)
      const person = await candidate(world, 'rec-weights', {
        roles: [role],
        level: 'middle',
        hoursPerWeek: 8,
        timezone: 'Europe/Samara',
        stack: ['typescript'],
      });
      const f = await teamWithDemand(world, {
        roleCode: role,
        openSeats: 1,
        seat: { minLevel: 'junior', minHours: 6, stack: ['typescript', 'react'] },
      });
      const [item] = await readyCandidates(f, 1);
      expect(item?.userId).toBe(person.id);
      const expected = 0.35 * 0.5 + 0.2 * 0.75 + 0.2 * (1 - 1 / 6) + 0.15 * 0.8 + 0.1 * 0;
      expect(item?.score).toBeCloseTo(Math.round(expected * 1000) / 1000, 3);
      expect(item?.reasons).toMatchObject({
        role: true,
        stack: 0.5,
        level: 0.75,
        // a lead sees the hours and the time zone of a candidate in quarter steps only
        availability: 0.75,
        completedProjects: 0,
        matchedStackTags: ['typescript'],
      });
      expect(item?.reasons.timezone).toBe(0.75);
      expect(item?.reasons.timezoneDiffHours).toBe(1);
    });

    it('FR-MATCH-12: hard filters - level below the seat minimum, fewer hours than the seat minimum, time zone 7 h away (C-43), another role - leave the list', async () => {
      const role = await freshRole(world);
      const other = await freshRole(world);
      const ok = await candidate(world, 'rec-filter-ok', { roles: [role], ...GOOD });
      await candidate(world, 'rec-filter-level', { roles: [role], ...GOOD, level: 'beginner' });
      await candidate(world, 'rec-filter-hours', { roles: [role], ...GOOD, hoursPerWeek: 5 });
      await candidate(world, 'rec-filter-tz', {
        roles: [role],
        ...GOOD,
        timezone: 'Asia/Vladivostok',
      });
      await candidate(world, 'rec-filter-role', { roles: [other], ...GOOD });
      const f = await teamWithDemand(world, {
        roleCode: role,
        openSeats: 1,
        seat: { minLevel: 'junior', minHours: 6 },
      });
      await readyCandidates(f, 1);
      // give a late job time to publish rows that must not be there, then compare
      await new Promise((resolve) => setTimeout(resolve, 6_000));
      const items = (await candidatesOf(f.lead, f, '?limit=100')).items;
      expect(items.map((i) => i.userId)).toEqual([ok.id]);
    });

    it('FR-MATCH-01: inQueue marks people who stand in the queue', async () => {
      const role = await freshRole(world);
      // a queued person who the auto-add must NOT take (score < 0.5): no stack match, level above the minimum
      const queued = await candidate(world, 'rec-queued', {
        roles: [role],
        level: 'middle',
        stack: [],
      });
      const passive = await candidate(world, 'rec-passive', { roles: [role], ...GOOD });
      await searchApplication(world, { roles: [role], user: queued });
      const f = await teamWithDemand(world, {
        roleCode: role,
        openSeats: 1,
        seat: { minLevel: 'beginner', minHours: 6 },
      });
      const items = await readyCandidates(f, 2);
      expect(items.find((i) => i.userId === queued.id)?.inQueue).toBe(true);
      expect(items.find((i) => i.userId === passive.id)?.inQueue).toBe(false);
    });

    it('FR-MATCH-01: cursor pagination - pages are disjoint, complete and in the same order as one big page (ties broken by id)', async () => {
      const role = await freshRole(world);
      for (let i = 0; i < 5; i += 1)
        await candidate(world, `rec-page-${i}`, { roles: [role], ...GOOD });
      const f = await teamWithDemand(world, { roleCode: role, openSeats: 1 });
      const all = await readyCandidates(f, 5);
      expect(all).toHaveLength(5);
      const seen: string[] = [];
      let cursor: string | null = null;
      let pages = 0;
      do {
        const page: Page<CandidateRecommendationDto> = await candidatesOf(
          f.lead,
          f,
          `?limit=2${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`,
        );
        expect(page.items.length).toBeLessThanOrEqual(2);
        seen.push(...page.items.map((i) => i.userId));
        cursor = page.nextCursor;
        pages += 1;
      } while (cursor && pages < 10);
      expect(pages).toBe(3);
      expect(seen).toEqual(all.map((i) => i.userId));
      expect(new Set(seen).size).toBe(5);
    });

    it('FR-MATCH-01: a malformed cursor or a limit outside 1..100 -> 400 VALIDATION_FAILED', async () => {
      const role = await freshRole(world);
      const f = await teamWithDemand(world, { roleCode: role, openSeats: 1 });
      const seatId = f.openSeats[0]?.id ?? '';
      for (const query of ['?limit=0', '?limit=101', '?cursor=not-a-cursor']) {
        expectProblem(
          'listSeatCandidates',
          await world.as(f.lead).get(seatCandidatesUrl(f.id, seatId, query)),
          400,
          'VALIDATION_FAILED',
        );
      }
    });

    it('FR-MATCH-12: after the person changes the profile (profiles.profile_updated) the score is recomputed', async () => {
      const role = await freshRole(world);
      const person = await candidate(world, 'rec-profile-change', {
        roles: [role],
        ...GOOD,
        stack: [],
      });
      const f = await teamWithDemand(world, { roleCode: role, openSeats: 1 });
      const before = (await readyCandidates(f, 1))[0];
      expect(before?.reasons.stack).toBe(0);
      const current = expectOk<{ version: number }>(
        'getMyProfile',
        await world.as(person).get('/v1/me/profile'),
        200,
      );
      expectOk(
        'saveMyProfile',
        await world.as(person).put(
          '/v1/me/profile',
          profileInput({
            displayName: 'rec-profile-change',
            rolePrefs: [{ roleCode: role, level: 'junior' }],
            stack: ['typescript'],
            version: current.version,
          }),
        ),
        200,
      );
      const after = await waitFor(
        async () => {
          const page = await candidatesOf(f.lead, f, '?limit=100');
          const item = page.items.find((i) => i.userId === person.id);
          return item && item.reasons.stack === 1 ? item : false;
        },
        WAIT,
        250,
      );
      expect(after.score).toBeGreaterThan(before?.score ?? 1);
    });

    it('FR-MATCH-01, SEC-11: a recommendation exposes only the contract fields - no e-mail, GitHub login, raw time zone or free-text fields of the profile', async () => {
      const role = await freshRole(world);
      const person = await candidate(world, 'rec-hidden', {
        roles: [role],
        ...GOOD,
        timezone: 'Europe/Samara',
        profile: {
          strengths: ['SECRET-STRENGTH-TEXT'],
          portfolioUrl: 'https://secret.example.test/p',
        },
      });
      const f = await teamWithDemand(world, { roleCode: role, openSeats: 1 });
      await readyCandidates(f, 1);
      const response = await world
        .as(f.lead)
        .get(seatCandidatesUrl(f.id, f.openSeats[0]?.id ?? '', '?limit=100'));
      const text = response.body;
      for (const secret of [
        person.email,
        'SECRET-STRENGTH-TEXT',
        'secret.example.test',
        'Europe/Samara',
        'hoursPerWeek',
        'github',
      ]) {
        expect(text, `leaked: ${secret}`).not.toContain(secret);
      }
      const keys = Object.keys(response.json<Page<Record<string, unknown>>>().items[0] ?? {});
      expect(keys.sort()).toEqual(
        ['computedAt', 'displayName', 'inQueue', 'reasons', 'score', 'userId'].sort(),
      );
    });

    it('FR-MATCH-01: people who already belong to the team are not recommended for its seat', async () => {
      const role = await freshRole(world);
      const f = await teamWithDemand(world, { roleCode: role, openSeats: 1, members: 2 });
      const member = f.members[0];
      if (!member) throw new Error('no member');
      const page = await candidatesOf(f.lead, f, '?limit=100');
      expect(page.items.map((i) => i.userId)).not.toContain(member.id);
      expect(page.items.map((i) => i.userId)).not.toContain(f.lead.id);
    });

    it('FR-MATCH-01: a team with nothing to recommend answers 200 with an empty page', async () => {
      const role = await freshRole(world);
      const f = await teamWithDemand(world, { roleCode: role, openSeats: 1 });
      const page = await candidatesOf(f.lead, f);
      expect(page).toEqual({ items: [], nextCursor: null });
    });
  },
);

describeInfra(
  'S4 matching: recommended teams for me (FR-MATCH-02, FR-MATCH-12)',
  ['db', 'redis'],
  () => {
    let world: World;

    beforeAll(async () => {
      world = await World.start();
      await world.ensureCatalog(['backend', 'frontend', 'pm', 'designer', 'qa', 'devops']);
    });

    afterAll(async () => {
      if (!world) return;
      await world.close();
    });

    const teamsFor = async (
      viewer: UserFixture,
      query = '',
    ): Promise<Page<TeamRecommendationDto>> =>
      expectOk<Page<TeamRecommendationDto>>(
        'listRecommendedTeams',
        await world.as(viewer).get(`/v1/me/recommended-teams${query}`),
        200,
      );

    const readyTeams = (viewer: UserFixture, count: number, query = '?limit=100') =>
      waitFor(
        async () => {
          const page = await teamsFor(viewer, query);
          return page.items.length >= count ? page.items : false;
        },
        WAIT,
        250,
      );

    it('FR-MATCH-02: teams with an open seat of my role that pass the filters, best first, with the reasons (contract schema)', async () => {
      const role = await freshRole(world);
      const me = await candidate(world, 'recteam-me', { roles: [role], ...GOOD });
      const strong = await teamWithDemand(world, { roleCode: role, openSeats: 1 });
      const weak = await teamWithDemand(world, {
        roleCode: role,
        openSeats: 1,
        seat: { stack: ['react', 'postgresql'] },
      });
      // not for me: the seat wants a higher level; another role
      await teamWithDemand(world, { roleCode: role, openSeats: 1, seat: { minLevel: 'middle' } });
      await teamWithDemand(world, { openSeats: 1 });
      const items = await readyTeams(me, 2);
      expect(items.map((i) => i.teamId)).toEqual([strong.id, weak.id]);
      expect(items[0]).toMatchObject({
        teamName: strong.dto.name,
        seatId: strong.openSeats[0]?.id,
        roleCode: role,
      });
      expect(items[0]?.score ?? 0).toBeGreaterThan(items[1]?.score ?? 1);
      expect(items[0]?.reasons).toMatchObject({
        role: true,
        stack: 1,
        matchedStackTags: ['typescript'],
      });
    });

    it('FR-MATCH-02: the `role` query keeps only seats of that role', async () => {
      const [a, b] = [await freshRole(world), await freshRole(world)];
      const me = await candidate(world, 'recteam-role-filter', { roles: [a, b], ...GOOD });
      const ta = await teamWithDemand(world, { roleCode: a, openSeats: 1 });
      const tb = await teamWithDemand(world, { roleCode: b, openSeats: 1 });
      expect((await readyTeams(me, 2)).map((i) => i.teamId).sort()).toEqual([ta.id, tb.id].sort());
      const onlyA = await teamsFor(me, `?role=${a}`);
      expect(onlyA.items.map((i) => i.teamId)).toEqual([ta.id]);
      expectProblem(
        'listRecommendedTeams',
        await world.as(me).get('/v1/me/recommended-teams?role=NOT%20A%20ROLE'),
        400,
        'VALIDATION_FAILED',
      );
    });

    it('FR-MATCH-02: cursor pagination - pages are disjoint and complete', async () => {
      const role = await freshRole(world);
      const me = await candidate(world, 'recteam-pages', { roles: [role], ...GOOD });
      for (let i = 0; i < 3; i += 1) await teamWithDemand(world, { roleCode: role, openSeats: 1 });
      const all = await readyTeams(me, 3);
      const first = await teamsFor(me, '?limit=2');
      expect(first.items).toHaveLength(2);
      expect(first.nextCursor).not.toBeNull();
      const second = await teamsFor(
        me,
        `?limit=2&cursor=${encodeURIComponent(first.nextCursor ?? '')}`,
      );
      expect(second.nextCursor).toBeNull();
      expect([...first.items, ...second.items].map((i) => i.seatId)).toEqual(
        all.map((i) => i.seatId),
      );
      expectProblem(
        'listRecommendedTeams',
        await world.as(me).get('/v1/me/recommended-teams?limit=0'),
        400,
        'VALIDATION_FAILED',
      );
    });

    it('FR-MATCH-02: a person without desired roles gets 200 and an empty page', async () => {
      const me = await candidate(world, 'recteam-none', { roles: [] });
      expect(await teamsFor(me)).toEqual({ items: [], nextCursor: null });
    });

    it('FR-MATCH-02, SEC-11: the team recommendation does not expose the lead or the members (no e-mail, no GitHub login)', async () => {
      const role = await freshRole(world);
      const me = await candidate(world, 'recteam-hidden', { roles: [role], ...GOOD });
      const f = await teamWithDemand(world, { roleCode: role, openSeats: 1 });
      await readyTeams(me, 1);
      const response = await world.as(me).get('/v1/me/recommended-teams?limit=100');
      expect(response.body).not.toContain(f.lead.email);
      expect(response.body).not.toContain(f.lead.id);
      const keys = Object.keys(response.json<Page<Record<string, unknown>>>().items[0] ?? {});
      expect(keys.sort()).toEqual(
        ['computedAt', 'reasons', 'roleCode', 'score', 'seatId', 'teamId', 'teamName'].sort(),
      );
    });

    it('FR-MATCH-02: a seat that was filled or closed disappears from the recommendations', async () => {
      const role = await freshRole(world);
      const me = await candidate(world, 'recteam-closed', { roles: [role], ...GOOD });
      const f = await teamWithDemand(world, { roleCode: role, openSeats: 2 });
      await readyTeams(me, 2);
      const seat = f.openSeats[0];
      if (!seat) throw new Error('no seat');
      expect((await world.as(f.lead).delete(`/v1/teams/${f.id}/seats/${seat.id}`)).statusCode).toBe(
        204,
      );
      const left = await waitFor(
        async () => {
          const items = (await teamsFor(me)).items;
          return items.every((i) => i.seatId !== seat.id) ? items : false;
        },
        WAIT,
        250,
      );
      expect(left.map((i) => i.seatId)).toEqual([f.openSeats[1]?.id]);
    });
  },
);

describeInfra(
  'S4 matching: no query per row in the recommendation lists (S4-04, N+1)',
  ['db', 'redis'],
  () => {
    let world: World;
    const counter = queryCounter();

    beforeAll(async () => {
      world = await World.start({ customizeApp: counter.customizeApp });
      await world.ensureCatalog(['backend', 'frontend', 'pm', 'designer', 'qa', 'devops']);
    });

    afterAll(async () => {
      if (!world) return;
      await world.close();
    });

    const statementsFor = async (viewer: UserFixture, url: string): Promise<number> => {
      counter.reset();
      const response = await world.as(viewer).get(url);
      expect(response.statusCode, response.body).toBe(200);
      return counter.count();
    };

    it('S4-04: listSeatCandidates sends the same number of statements for 2 and for 12 candidates', async () => {
      const [small, large] = [await freshRole(world), await freshRole(world)];
      for (let i = 0; i < 2; i += 1)
        await candidate(world, `n1-s-${i}`, { roles: [small], ...GOOD });
      for (let i = 0; i < 12; i += 1)
        await candidate(world, `n1-l-${i}`, { roles: [large], ...GOOD });
      const fs = await teamWithDemand(world, { roleCode: small, openSeats: 1 });
      const fl = await teamWithDemand(world, { roleCode: large, openSeats: 1 });
      const url = (f: TeamFixture): string =>
        seatCandidatesUrl(f.id, f.openSeats[0]?.id ?? '', '?limit=100');
      await waitFor(
        async () =>
          (await world.as(fs.lead).get(url(fs))).json<Page<unknown>>().items.length >= 2 &&
          (await world.as(fl.lead).get(url(fl))).json<Page<unknown>>().items.length >= 12,
        WAIT,
        250,
      );
      const few = await statementsFor(fs.lead, url(fs));
      const many = await statementsFor(fl.lead, url(fl));
      expect(many).toBe(few);
      expect(many).toBeLessThanOrEqual(15);
    });

    it('S4-04: listRecommendedTeams sends the same number of statements for 1 and for 8 teams', async () => {
      const [small, large] = [await freshRole(world), await freshRole(world)];
      const [few, many] = [
        await candidate(world, 'n1-teams-few', { roles: [small], ...GOOD }),
        await candidate(world, 'n1-teams-many', { roles: [large], ...GOOD }),
      ];
      await teamWithDemand(world, { roleCode: small, openSeats: 1 });
      for (let i = 0; i < 8; i += 1) await teamWithDemand(world, { roleCode: large, openSeats: 1 });
      await waitFor(
        async () =>
          (await world.as(few).get('/v1/me/recommended-teams')).json<Page<unknown>>().items
            .length >= 1 &&
          (await world.as(many).get('/v1/me/recommended-teams?limit=100')).json<Page<unknown>>()
            .items.length >= 8,
        WAIT,
        250,
      );
      const fewCount = await statementsFor(few, '/v1/me/recommended-teams?limit=100');
      const manyCount = await statementsFor(many, '/v1/me/recommended-teams?limit=100');
      expect(manyCount).toBe(fewCount);
      expect(manyCount).toBeLessThanOrEqual(15);
    });
  },
);
