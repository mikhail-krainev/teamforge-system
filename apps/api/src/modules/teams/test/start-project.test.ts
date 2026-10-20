import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { expectProblem, expectReplayed } from '../../../../test/fixtures/assertions.js';
import {
  DAY,
  expectOk,
  githubUser,
  seatInput,
  team,
  type TeamDto,
} from '../../../../test/fixtures/teams.js';
import { eventCount, teamRow } from '../../../../test/fixtures/teams-db.js';
import type { World } from '../../../../test/fixtures/world.js';
import { FakeClock } from '../../../../test/helpers/clock.js';
import { describeInfra, waitFor } from '../../../../test/helpers/infra.js';
import { startWorld } from './support.js';

describeInfra(
  'S3 teams: starting the project and the team status machine (FR-TEAM-10, -27)',
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

    describe('startProject', () => {
      it('FR-TEAM-10: forming -> active with startedAt and a planned end; the lead alone is enough', async () => {
        const t = await team(world);
        const response = await world.as(t.lead).post(`/v1/teams/${t.id}/start`);
        const started = expectOk<TeamDto>('startProject', response, 200);
        expect(started.status).toBe('active');
        expect(started.startedAt).not.toBeNull();
        expect(started.plannedEndAt).not.toBeNull();
        expect(Date.parse(started.startedAt ?? '')).toBe(clock.now().getTime());
        expect((await teamRow(world, t.id)).status).toBe('active');
      });

      it('FR-TEAM-10: a repeated start -> 409 INVALID_STATE (a new key; the same key replays the 200)', async () => {
        const t = await team(world);
        const key = randomUUID();
        expectOk(
          'startProject',
          await world
            .as(t.lead)
            .post(`/v1/teams/${t.id}/start`, undefined, { idempotencyKey: key }),
          200,
        );
        const again = await world.as(t.lead).post(`/v1/teams/${t.id}/start`);
        expectProblem('startProject', again, 409, 'INVALID_STATE');
        const replay = await world
          .as(t.lead)
          .post(`/v1/teams/${t.id}/start`, undefined, { idempotencyKey: key });
        expect(replay.statusCode).toBe(200);
        expectReplayed(replay);
      });

      it('FR-TEAM-10: workspace opens the route in the start transaction: one stage per playbook stage, at most one open', async () => {
        const t = await team(world);
        await world.as(t.lead).post(`/v1/teams/${t.id}/start`);
        const rows = await world.sql<{ stages: number; open: number; expected: number }[]>`
          SELECT (SELECT count(*)::int FROM workspace.project_stage WHERE team_id = ${t.id}) AS stages,
                 (SELECT count(*)::int FROM workspace.project_stage
                   WHERE team_id = ${t.id} AND status = 'open') AS open,
                 (SELECT count(*)::int FROM playbooks.stage s
                    JOIN teams.team tm ON tm.playbook_id = s.playbook_id
                   WHERE tm.id = ${t.id}) AS expected`;
        const counts = rows[0];
        expect(counts?.stages).toBe(counts?.expected);
        expect(counts?.open).toBe(counts?.expected === 0 ? 0 : 1);
      });

      it('FR-TEAM-10: a member who is not the lead -> 403 NOT_TEAM_LEAD; a stranger -> 404', async () => {
        const t = await team(world, { members: 2 });
        const member = t.members[0];
        if (!member) throw new Error('no member');
        const stranger = await githubUser(world, 'start-stranger');
        expectProblem(
          'startProject',
          await world.as(member).post(`/v1/teams/${t.id}/start`),
          403,
          'NOT_TEAM_LEAD',
        );
        expectProblem(
          'startProject',
          await world.as(stranger).post(`/v1/teams/${t.id}/start`),
          404,
          'NOT_FOUND',
        );
        expect((await teamRow(world, t.id)).status).toBe('forming');
      });

      it('FR-TEAM-10: the start writes one journal entry and does not touch the seats', async () => {
        const t = await team(world, { openSeats: 2 });
        await world.as(t.lead).post(`/v1/teams/${t.id}/start`);
        expect(await eventCount(world, t.id, 'team_started')).toBe(1);
        const after = expectOk<TeamDto>(
          'getTeam',
          await world.as(t.lead).get(`/v1/teams/${t.id}`),
          200,
        );
        expect(after.seats.filter((s) => s.status === 'open')).toHaveLength(2);
      });
    });

    describe('team status machine', () => {
      it('FR-TEAM-27: 120 days after the start the team is suspended with reason max_duration (C-06)', async () => {
        const t = await team(world, { status: 'active' });
        clock.advance(121 * DAY);
        await world.runMaintenance('max-duration-scan');
        const suspended = await waitFor(async () => {
          const dto = expectOk<TeamDto & { statusReason?: string | null }>(
            'getTeam',
            await world.as(t.lead).get(`/v1/teams/${t.id}`),
            200,
          );
          return dto.status === 'suspended' ? dto : false;
        }, 20_000);
        expect(suspended.statusReason).toBe('max_duration');
      });

      it('FR-TEAM-27: in a suspended team the lead actions fail with 409 TEAM_STATUS_BLOCKS_ACTION', async () => {
        const t = await team(world, { status: 'active', openSeats: 1 });
        clock.advance(121 * DAY);
        await world.runMaintenance('max-duration-scan');
        await waitFor(async () => (await teamRow(world, t.id)).status === 'suspended', 20_000);
        const seat = t.openSeats[0];
        if (!seat) throw new Error('no seat');
        expectProblem(
          'addSeats',
          await world.as(t.lead).post(`/v1/teams/${t.id}/seats`, { seats: [seatInput()] }),
          409,
          'TEAM_STATUS_BLOCKS_ACTION',
        );
        expectProblem(
          'updateSeat',
          await world
            .as(t.lead)
            .patch(`/v1/teams/${t.id}/seats/${seat.id}`, { desired: true, version: seat.version }),
          409,
          'TEAM_STATUS_BLOCKS_ACTION',
        );
        const candidate = await githubUser(world, 'suspended-candidate');
        const offer = await world
          .as(t.lead)
          .post(`/v1/teams/${t.id}/seat-offers`, { seatId: seat.id, userId: candidate.id });
        expectProblem('createSeatOffer', offer, 409, 'TEAM_STATUS_BLOCKS_ACTION');
      });

      it('FR-TEAM-27: a started team cannot be started again after a suspension either -> 409', async () => {
        const t = await team(world, { status: 'active' });
        clock.advance(121 * DAY);
        await world.runMaintenance('max-duration-scan');
        await waitFor(async () => (await teamRow(world, t.id)).status === 'suspended', 20_000);
        const response = await world.as(t.lead).post(`/v1/teams/${t.id}/start`);
        expect(response.statusCode).toBe(409);
        expect(['INVALID_STATE', 'TEAM_STATUS_BLOCKS_ACTION']).toContain(
          response.json<{ code: string }>().code,
        );
      });

      it('FR-TEAM-27: while a vote is open the team is `voting`; adding seats and starting are blocked', async () => {
        const t = await team(world, { members: 5, openSeats: 1, status: 'active' });
        clock.advance(15 * DAY);
        const [b, c, d] = t.members;
        if (!b || !c || !d) throw new Error('need members');
        // C-15: the lead is inactive for more than 14 days; half of the members (ceil(5/2) = 3) ask for a vote.
        for (const requester of [b, c, d]) {
          expectOk(
            'requestLeaderVote',
            await world.as(requester).post(`/v1/teams/${t.id}/leader-vote-requests`),
            201,
          );
        }
        expect((await teamRow(world, t.id)).status).toBe('voting');
        const blocked = await world
          .as(t.lead)
          .post(`/v1/teams/${t.id}/seats`, { seats: [seatInput()] });
        expectProblem('addSeats', blocked, 409, 'TEAM_STATUS_BLOCKS_ACTION');
      });
    });
  },
);
