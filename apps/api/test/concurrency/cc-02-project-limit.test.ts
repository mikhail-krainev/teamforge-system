import { afterAll, beforeAll, expect, it } from 'vitest';
import { codesAt, expectReplayOf, fireAll, tally, winnerOf } from '../fixtures/concurrency.js';
import {
  expectOk,
  githubUser,
  joinThroughOffer,
  team,
  teamInput,
  teamWithOpenSeat,
  type OfferDto,
} from '../fixtures/teams.js';
import { activeMembershipsOf, expectNoDeadlocks, teamRow } from '../fixtures/teams-db.js';
import { World } from '../fixtures/world.js';
import { describeInfra } from '../helpers/infra.js';

describeInfra(
  'CC-2: joining and the project limit C-10 / team size C-02 (FR-TEAM-05, -06)',
  ['db', 'redis'],
  () => {
    let world: World;
    let deadlocksBefore = 0;

    beforeAll(async () => {
      world = await World.start();
      await world.ensureCatalog(['backend', 'frontend', 'pm', 'designer', 'qa', 'devops']);
      deadlocksBefore = await world.deadlocks();
    });

    afterAll(async () => {
      if (!world) return;
      await expectNoDeadlocks(world, deadlocksBefore);
      await world.close();
    });

    it('CC-2(а): one user accepts 5 offers of 5 teams in parallel -> exactly 2 succeed, 3 are PROJECT_LIMIT', async () => {
      const candidate = await githubUser(world, 'cc2a-candidate');
      const offers: { id: string }[] = [];
      for (let i = 0; i < 5; i += 1) {
        const t = await team(world, { openSeats: 1 });
        const seat = t.openSeats[0];
        if (!seat) throw new Error('no seat');
        offers.push(
          expectOk<OfferDto>(
            'createSeatOffer',
            await world
              .as(t.lead)
              .post(`/v1/teams/${t.id}/seat-offers`, { seatId: seat.id, userId: candidate.id }),
            201,
          ),
        );
      }
      const fired = await fireAll(5, (i, key) =>
        world
          .as(candidate)
          .post(`/v1/seat-offers/${offers[i]?.id}/acceptance`, undefined, { idempotencyKey: key }),
      );
      expect(tally(fired)).toEqual({ 200: 2, 409: 3 });
      expect(codesAt(fired, 409)).toEqual(['PROJECT_LIMIT']);
      expect(await activeMembershipsOf(world, candidate.id)).toBe(2);
      const winner = winnerOf(fired, 200);
      const replay = await world
        .as(candidate)
        .post(`/v1/seat-offers/${offers[winner.index]?.id}/acceptance`, undefined, {
          idempotencyKey: winner.key,
        });
      expectReplayOf(winner, replay);
      expect(await activeMembershipsOf(world, candidate.id)).toBe(2);
    });

    it('CC-2(а): the same burst of 20 acceptances of 20 offers from 20 teams keeps the user at 2 projects', async () => {
      const candidate = await githubUser(world, 'cc2a-burst');
      const offers: { id: string }[] = [];
      for (let i = 0; i < 20; i += 1) {
        const t = await team(world, { openSeats: 1 });
        const seat = t.openSeats[0];
        if (!seat) throw new Error('no seat');
        offers.push(
          expectOk<OfferDto>(
            'createSeatOffer',
            await world
              .as(t.lead)
              .post(`/v1/teams/${t.id}/seat-offers`, { seatId: seat.id, userId: candidate.id }),
            201,
          ),
        );
      }
      const fired = await fireAll(20, (i, key) =>
        world
          .as(candidate)
          .post(`/v1/seat-offers/${offers[i]?.id}/acceptance`, undefined, { idempotencyKey: key }),
      );
      expect(tally(fired)).toEqual({ 200: 2, 409: 18 });
      expect(await activeMembershipsOf(world, candidate.id)).toBe(2);
    });

    it('CC-2(б): a team of 7 and twenty candidates for its free seats -> one success, the others TEAM_FULL', async () => {
      // C-04 allows 12 seats, so 7 members leave 5 open seats; 20 candidates are spread over them.
      const f = await teamWithOpenSeat(world, { members: 7, openSeats: 5, candidates: 20 });
      const fired = await fireAll(20, (i, key) =>
        world
          .as(f.candidates[i] ?? f.lead)
          .post(`/v1/seat-offers/${f.offers[i]?.id}/acceptance`, undefined, {
            idempotencyKey: key,
          }),
      );
      expect(tally(fired)).toEqual({ 200: 1, 409: 19 });
      // Contract ambiguity: a loser that wanted the winner's seat may get SEAT_TAKEN instead of TEAM_FULL.
      expect(codesAt(fired, 409).every((c) => c === 'TEAM_FULL' || c === 'SEAT_TAKEN')).toBe(true);
      expect(codesAt(fired, 409)).toContain('TEAM_FULL');
      expect(await teamRow(world, f.id)).toMatchObject({ member_count: 8 });
      const winner = winnerOf(fired, 200);
      const replay = await world
        .as(f.candidates[winner.index] ?? f.lead)
        .post(`/v1/seat-offers/${f.offers[winner.index]?.id}/acceptance`, undefined, {
          idempotencyKey: winner.key,
        });
      expectReplayOf(winner, replay);
      expect((await teamRow(world, f.id)).member_count).toBe(8);
    });

    it('CC-2(б): five candidates on five different seats of a team of 7 -> 1 x 200, 4 x TEAM_FULL (strict codes)', async () => {
      const f = await teamWithOpenSeat(world, { members: 7, openSeats: 5, candidates: 5 });
      const fired = await fireAll(5, (i, key) =>
        world
          .as(f.candidates[i] ?? f.lead)
          .post(`/v1/seat-offers/${f.offers[i]?.id}/acceptance`, undefined, {
            idempotencyKey: key,
          }),
      );
      expect(tally(fired)).toEqual({ 200: 1, 409: 4 });
      expect(codesAt(fired, 409)).toEqual(['TEAM_FULL']);
    });

    it('CC-2(в): createTeam + two joins in parallel for a user with 1 project -> exactly 1 success', async () => {
      const candidate = await githubUser(world, 'cc2c-candidate');
      const first = await team(world, { openSeats: 1 });
      const firstSeat = first.openSeats[0];
      if (!firstSeat) throw new Error('no seat');
      await joinThroughOffer(world, first.lead, first.id, firstSeat.id, candidate);
      const offers: { id: string }[] = [];
      for (let i = 0; i < 2; i += 1) {
        const t = await team(world, { openSeats: 1 });
        const seat = t.openSeats[0];
        if (!seat) throw new Error('no seat');
        offers.push(
          expectOk<OfferDto>(
            'createSeatOffer',
            await world
              .as(t.lead)
              .post(`/v1/teams/${t.id}/seat-offers`, { seatId: seat.id, userId: candidate.id }),
            201,
          ),
        );
      }
      const fired = await fireAll(3, (i, key) =>
        i === 0
          ? world.as(candidate).post('/v1/teams', teamInput(), { idempotencyKey: key })
          : world.as(candidate).post(`/v1/seat-offers/${offers[i - 1]?.id}/acceptance`, undefined, {
              idempotencyKey: key,
            }),
      );
      expect(tally(fired)[409]).toBe(2);
      expect(
        Object.entries(tally(fired))
          .filter(([s]) => s !== '409')
          .reduce((sum, [, n]) => sum + n, 0),
      ).toBe(1);
      expect(codesAt(fired, 409)).toEqual(['PROJECT_LIMIT']);
      expect(await activeMembershipsOf(world, candidate.id)).toBe(2);
      const winner = fired.find((f) => f.status < 300);
      if (!winner) throw new Error('no winner');
      const replay =
        winner.index === 0
          ? await world.as(candidate).post('/v1/teams', teamInput(), { idempotencyKey: winner.key })
          : await world
              .as(candidate)
              .post(`/v1/seat-offers/${offers[winner.index - 1]?.id}/acceptance`, undefined, {
                idempotencyKey: winner.key,
              });
      expect(replay.headers['idempotent-replayed']).toBe('true');
    });
  },
);
