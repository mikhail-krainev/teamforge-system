import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { expectProblem, expectReplayed } from '../../../../test/fixtures/assertions.js';
import {
  expectOk,
  githubUser,
  joinThroughOffer,
  seatInput,
  team,
  type SeatDto,
} from '../../../../test/fixtures/teams.js';
import { seatStatus, teamRow } from '../../../../test/fixtures/teams-db.js';
import type { World } from '../../../../test/fixtures/world.js';
import { describeInfra } from '../../../../test/helpers/infra.js';
import { startWorld } from './support.js';

interface EventDto {
  id: string;
  type: string;
  actorUserId: string | null;
  payload: Record<string, unknown>;
  at: string;
}

describeInfra(
  'S3 teams: seats and the team journal (FR-TEAM-02, -03, -12)',
  ['db', 'redis'],
  () => {
    let world: World;

    beforeAll(async () => {
      world = await startWorld();
    });

    afterAll(async () => {
      if (!world) return;
      await world.close();
    });

    describe('addSeats', () => {
      it('FR-TEAM-02: the lead adds seats; they are open and counted in seat_count', async () => {
        const t = await team(world, { openSeats: 1 });
        const response = await world
          .as(t.lead)
          .post(`/v1/teams/${t.id}/seats`, { seats: [seatInput({ roleCode: 'qa', count: 2 })] });
        const added = expectOk<{ items: SeatDto[] }>('addSeats', response, 201);
        expect(added.items).toHaveLength(2);
        expect(added.items.every((s) => s.roleCode === 'qa' && s.status === 'open')).toBe(true);
        expect((await teamRow(world, t.id)).seat_count).toBe(3);
      });

      it('FR-TEAM-02: past 12 seats in total -> 422 SEAT_LIMIT and nothing is added (C-04)', async () => {
        const t = await team(world, { openSeats: 11 });
        const response = await world
          .as(t.lead)
          .post(`/v1/teams/${t.id}/seats`, { seats: [seatInput({ count: 2 })] });
        expectProblem('addSeats', response, 422, 'SEAT_LIMIT');
        expect((await teamRow(world, t.id)).seat_count).toBe(11);
      });

      it('FR-TEAM-02: a role outside the catalog -> 422; an empty list -> 400', async () => {
        const t = await team(world);
        const unknown = await world
          .as(t.lead)
          .post(`/v1/teams/${t.id}/seats`, { seats: [seatInput({ roleCode: 'no_such_role' })] });
        expect(unknown.statusCode, unknown.body).toBe(422);
        const empty = await world.as(t.lead).post(`/v1/teams/${t.id}/seats`, { seats: [] });
        expectProblem('addSeats', empty, 400, 'VALIDATION_FAILED');
      });

      it('FR-TEAM-02: a member who is not the lead -> 403 NOT_TEAM_LEAD; a stranger -> 404', async () => {
        const t = await team(world, { members: 2 });
        const member = t.members[0];
        if (!member) throw new Error('no member');
        const stranger = await githubUser(world, 'seats-stranger');
        const body = { seats: [seatInput()] };
        expectProblem(
          'addSeats',
          await world.as(member).post(`/v1/teams/${t.id}/seats`, body),
          403,
          'NOT_TEAM_LEAD',
        );
        expectProblem(
          'addSeats',
          await world.as(stranger).post(`/v1/teams/${t.id}/seats`, body),
          404,
          'NOT_FOUND',
        );
      });

      it('FR-WORK-08: the same key adds the seats once', async () => {
        const t = await team(world, { openSeats: 0 });
        const key = randomUUID();
        const body = { seats: [seatInput({ count: 2 })] };
        expectOk(
          'addSeats',
          await world.as(t.lead).post(`/v1/teams/${t.id}/seats`, body, { idempotencyKey: key }),
          201,
        );
        const again = await world
          .as(t.lead)
          .post(`/v1/teams/${t.id}/seats`, body, { idempotencyKey: key });
        expect(again.statusCode).toBe(201);
        expectReplayed(again);
        expect((await teamRow(world, t.id)).seat_count).toBe(2);
      });
    });

    describe('updateSeat', () => {
      it('FR-TEAM-03: toggling `desired` is journaled with time and author and stamps desiredChangedAt', async () => {
        const t = await team(world, { openSeats: 1 });
        const seat = t.openSeats[0];
        if (!seat) throw new Error('no seat');
        const response = await world
          .as(t.lead)
          .patch(`/v1/teams/${t.id}/seats/${seat.id}`, { desired: true, version: seat.version });
        const updated = expectOk<SeatDto & { desiredChangedAt: string | null }>(
          'updateSeat',
          response,
          200,
        );
        expect(updated.desired).toBe(true);
        expect(updated.desiredChangedAt).not.toBeNull();
        expect(updated.version).toBe(seat.version + 1);
        const events = expectOk<{ items: EventDto[] }>(
          'listTeamEvents',
          await world.as(t.lead).get(`/v1/teams/${t.id}/events`),
          200,
        );
        const changed = events.items.find(
          (e) => e.actorUserId === t.lead.id && JSON.stringify(e.payload).includes(seat.id),
        );
        expect(changed, 'a journal entry for the desired change').toBeDefined();
      });

      it('FR-TEAM-02: level, hours and stack can be changed', async () => {
        const t = await team(world, { openSeats: 1 });
        const seat = t.openSeats[0];
        if (!seat) throw new Error('no seat');
        const response = await world.as(t.lead).patch(`/v1/teams/${t.id}/seats/${seat.id}`, {
          minLevel: 'middle',
          minHours: 20,
          stack: ['react', 'typescript'],
          version: seat.version,
        });
        expect(expectOk<SeatDto>('updateSeat', response, 200)).toMatchObject({
          minLevel: 'middle',
          minHours: 20,
        });
      });

      it('FR-TEAM-02: a stale seat version -> 409 VERSION_CONFLICT with the current seat', async () => {
        const t = await team(world, { openSeats: 1 });
        const seat = t.openSeats[0];
        if (!seat) throw new Error('no seat');
        await world
          .as(t.lead)
          .patch(`/v1/teams/${t.id}/seats/${seat.id}`, { minHours: 8, version: seat.version });
        const stale = await world
          .as(t.lead)
          .patch(`/v1/teams/${t.id}/seats/${seat.id}`, { minHours: 9, version: seat.version });
        const problem = expectProblem('updateSeat', stale, 409, 'VERSION_CONFLICT');
        expect(problem.current).toMatchObject({ minHours: 8 });
      });

      it('FR-TEAM-02: no version -> 400 VERSION_MISSING; minHours out of range -> 400', async () => {
        const t = await team(world, { openSeats: 1 });
        const seat = t.openSeats[0];
        if (!seat) throw new Error('no seat');
        expectProblem(
          'updateSeat',
          await world.as(t.lead).patch(`/v1/teams/${t.id}/seats/${seat.id}`, { desired: true }),
          400,
          'VERSION_MISSING',
        );
        expectProblem(
          'updateSeat',
          await world
            .as(t.lead)
            .patch(`/v1/teams/${t.id}/seats/${seat.id}`, { minHours: 99, version: seat.version }),
          400,
          'VALIDATION_FAILED',
        );
      });

      it('FR-TEAM-02: a member who is not the lead -> 403 NOT_TEAM_LEAD', async () => {
        const t = await team(world, { members: 2, openSeats: 1 });
        const member = t.members[0];
        const seat = t.openSeats[0];
        if (!member || !seat) throw new Error('no fixture');
        const response = await world
          .as(member)
          .patch(`/v1/teams/${t.id}/seats/${seat.id}`, { desired: true, version: seat.version });
        expectProblem('updateSeat', response, 403, 'NOT_TEAM_LEAD');
      });
    });

    describe('closeSeat', () => {
      it('FR-TEAM-02: the lead closes an open seat (204); it stays in the team as closed', async () => {
        const t = await team(world, { openSeats: 2 });
        const seat = t.openSeats[0];
        if (!seat) throw new Error('no seat');
        expectOk(
          'closeSeat',
          await world.as(t.lead).delete(`/v1/teams/${t.id}/seats/${seat.id}`),
          204,
        );
        expect(await seatStatus(world, seat.id)).toBe('closed');
      });

      it('FR-TEAM-12: a filled seat cannot be closed -> 409 INVALID_STATE (architecture 12.3)', async () => {
        const t = await team(world, { openSeats: 1 });
        const seat = t.openSeats[0];
        if (!seat) throw new Error('no seat');
        const candidate = await githubUser(world, 'close-filled');
        await joinThroughOffer(world, t.lead, t.id, seat.id, candidate);
        const response = await world.as(t.lead).delete(`/v1/teams/${t.id}/seats/${seat.id}`);
        // The contract text of closeSeat says SEAT_NOT_OPEN, architecture 12.3 and the plan say INVALID_STATE.
        expectProblem('closeSeat', response, 409, 'INVALID_STATE');
        expect(await seatStatus(world, seat.id)).toBe('filled');
      });

      it('FR-TEAM-12: a closed seat cannot be closed twice -> 409', async () => {
        const t = await team(world, { openSeats: 1 });
        const seat = t.openSeats[0];
        if (!seat) throw new Error('no seat');
        await world.as(t.lead).delete(`/v1/teams/${t.id}/seats/${seat.id}`);
        const again = await world.as(t.lead).delete(`/v1/teams/${t.id}/seats/${seat.id}`);
        expectProblem('closeSeat', again, 409, 'INVALID_STATE');
      });

      it('FR-TEAM-30: pending offers for a closed seat can no longer be accepted -> 409 SEAT_NOT_OPEN, the offer is cancelled', async () => {
        const t = await team(world, { openSeats: 1 });
        const seat = t.openSeats[0];
        if (!seat) throw new Error('no seat');
        const candidate = await githubUser(world, 'close-offer');
        const offer = expectOk<{ id: string }>(
          'createSeatOffer',
          await world
            .as(t.lead)
            .post(`/v1/teams/${t.id}/seat-offers`, { seatId: seat.id, userId: candidate.id }),
          201,
        );
        await world.as(t.lead).delete(`/v1/teams/${t.id}/seats/${seat.id}`);
        const accepted = await world.as(candidate).post(`/v1/seat-offers/${offer.id}/acceptance`);
        expectProblem('acceptSeatOffer', accepted, 409, 'SEAT_NOT_OPEN');
        const mine = expectOk<{ items: { id: string; status: string }[] }>(
          'listMySeatOffers',
          await world.as(candidate).get('/v1/me/seat-offers'),
          200,
        );
        expect(mine.items.find((o) => o.id === offer.id)?.status).toBe('cancelled');
      });
    });

    describe('listTeamEvents', () => {
      it('FR-TEAM-21: a member reads the journal, newest first, with cursor pages', async () => {
        const t = await team(world, { members: 2, openSeats: 2 });
        const member = t.members[0];
        const seat = t.openSeats[0];
        if (!member || !seat) throw new Error('no fixture');
        await world
          .as(t.lead)
          .patch(`/v1/teams/${t.id}/seats/${seat.id}`, { desired: true, version: seat.version });
        const page = expectOk<{ items: EventDto[]; nextCursor: string | null }>(
          'listTeamEvents',
          await world.as(member).get(`/v1/teams/${t.id}/events?limit=1`),
          200,
        );
        expect(page.items).toHaveLength(1);
        expect(page.nextCursor).not.toBeNull();
        const next = expectOk<{ items: EventDto[] }>(
          'listTeamEvents',
          await world
            .as(member)
            .get(
              `/v1/teams/${t.id}/events?limit=1&cursor=${encodeURIComponent(page.nextCursor ?? '')}`,
            ),
          200,
        );
        expect(next.items[0]?.id).not.toBe(page.items[0]?.id);
        expect(Date.parse(page.items[0]?.at ?? '')).toBeGreaterThanOrEqual(
          Date.parse(next.items[0]?.at ?? ''),
        );
      });

      it('FR-TEAM-21: a user outside the team gets 404 (not 403)', async () => {
        const t = await team(world);
        const stranger = await githubUser(world, 'events-stranger');
        expectProblem(
          'listTeamEvents',
          await world.as(stranger).get(`/v1/teams/${t.id}/events`),
          404,
          'NOT_FOUND',
        );
      });
    });
  },
);
