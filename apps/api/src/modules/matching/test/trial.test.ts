import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { expectProblem, expectReplayed } from '../../../../test/fixtures/assertions.js';
import type { UserFixture } from '../../../../test/fixtures/index.js';
import {
  activeApplications,
  applicationRoles,
  applicationRow,
  applicationsOf,
  exclusionTeams,
  membershipRow,
  waitSamples,
} from '../../../../test/fixtures/matching-db.js';
import {
  applicationBody,
  autoAddedMember,
  DAY,
  fireTrialExpire,
  freshRole,
  readTeam,
  runAutoAdd,
  searchApplication,
  teamWithDemand,
  TRIAL_MS,
  waitFulfilled,
  type AutoAddedMember,
  type SearchApplicationDto,
} from '../../../../test/fixtures/matching.js';
import { expectOk, type MemberDto } from '../../../../test/fixtures/teams.js';
import { seatStatus } from '../../../../test/fixtures/teams-db.js';
import type { World } from '../../../../test/fixtures/world.js';
import { FakeClock } from '../../../../test/helpers/clock.js';
import { describeInfra, waitFor } from '../../../../test/helpers/infra.js';
import { startWorld } from './support.js';

const HOUR = 3_600_000;
const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 7_000));
const MY_APPLICATION = '/v1/me/search-application';

describeInfra(
  'S4 matching: the trial period - exclude, confirm, leave, return to the queue (FR-TEAM-22, -23, -24, FR-MATCH-08)',
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

    const exclude = (f: AutoAddedMember, userId = f.member.id, key?: string) =>
      world
        .as(f.lead)
        .delete(`/v1/teams/${f.id}/members/${userId}`, key ? { idempotencyKey: key } : undefined);
    const confirm = (f: AutoAddedMember, userId = f.member.id, key?: string) =>
      world
        .as(f.lead)
        .post(
          `/v1/teams/${f.id}/members/${userId}/trial-confirmation`,
          undefined,
          key ? { idempotencyKey: key } : undefined,
        );
    const memberIn = async (f: AutoAddedMember): Promise<MemberDto | undefined> =>
      (await readTeam(world, f.lead, f.id)).members.find((m) => m.userId === f.member.id);
    const waitRestored = (user: UserFixture): Promise<SearchApplicationDto> =>
      waitFor(
        async () => {
          const response = await world.as(user).get(MY_APPLICATION);
          return response.statusCode === 200 ? response.json<SearchApplicationDto>() : false;
        },
        30_000,
        100,
      );

    describe('excludeTrialMember (FR-TEAM-22)', () => {
      it('the lead excludes an auto-added member in the trial: 204, the member is gone, the seat is open again, the membership is removed_in_trial', async () => {
        const f = await autoAddedMember(world);
        expectOk('excludeTrialMember', await exclude(f), 204);
        const row = await membershipRow(world, f.id, f.member.id);
        expect(row).toMatchObject({ status: 'removed', left_reason: 'removed_in_trial' });
        const dto = await readTeam(world, f.lead, f.id);
        expect(
          dto.members.find((m) => m.userId === f.member.id && m.status === 'active'),
        ).toBeUndefined();
        expect(dto.memberCount).toBe(f.dto.memberCount - 1);
        expect(dto.seats.find((s) => s.id === f.seat.id)).toMatchObject({
          status: 'open',
          holderUserId: null,
        });
      });

      it('FR-MATCH-08: the application comes back - same id, same enqueuedAt, same roles and priorities, the team is remembered as an exclusion', async () => {
        const f = await autoAddedMember(world);
        const before = await applicationRoles(world, f.application.id);
        expectOk('excludeTrialMember', await exclude(f), 204);
        const restored = await waitRestored(f.member);
        expect(restored).toMatchObject({
          id: f.application.id,
          status: 'active',
          enqueuedAt: f.application.enqueuedAt,
        });
        expect(restored.roles.map((r) => [r.roleCode, r.priority])).toEqual(
          before.map((r) => [r.role_code, r.priority]),
        );
        expect(await exclusionTeams(world, f.application.id)).toEqual([f.id]);
        expect((await applicationRoles(world, f.application.id)).every((r) => r.is_active)).toBe(
          true,
        );
        expect(await waitSamples(world, f.application.id)).toHaveLength(1);
      });

      it('FR-MATCH-08: the excluded person is never auto-added to the same team again, but is added to another team with a seat', async () => {
        const f = await autoAddedMember(world);
        expectOk('excludeTrialMember', await exclude(f), 204);
        await waitRestored(f.member);
        await runAutoAdd(world);
        await settle();
        expect((await applicationRow(world, f.application.id)).status).toBe('active');
        expect(await seatStatus(world, f.seat.id)).toBe('open');
        const other = await teamWithDemand(world, { roleCode: f.roleCode, openSeats: 1 });
        await runAutoAdd(world);
        await waitFulfilled(world, f.application.id);
        expect((await applicationRow(world, f.application.id)).fulfilled_team_id).toBe(other.id);
      });

      it('FR-MATCH-08: the time spent in the excluding team does not count as waiting (paused_seconds, the second wait sample)', async () => {
        const role = await freshRole(world);
        const queued = await searchApplication(world, { roles: [role], label: 'pause' });
        clock.advance(HOUR);
        const first = await teamWithDemand(world, { roleCode: role, openSeats: 1 });
        await runAutoAdd(world);
        await waitFulfilled(world, queued.application.id);
        clock.advance(2 * DAY);
        expectOk(
          'excludeTrialMember',
          await world.as(first.lead).delete(`/v1/teams/${first.id}/members/${queued.user.id}`),
          204,
        );
        await waitRestored(queued.user);
        const paused = (await applicationRow(world, queued.application.id)).paused_seconds;
        expect(paused).toBeGreaterThanOrEqual(2 * 86_400 - 60);
        expect(paused).toBeLessThanOrEqual(2 * 86_400 + 600);
        clock.advance(HOUR);
        await teamWithDemand(world, { roleCode: role, openSeats: 1 });
        await runAutoAdd(world);
        await waitFor(
          async () => (await waitSamples(world, queued.application.id)).length >= 2,
          30_000,
        );
        const samples = await waitSamples(world, queued.application.id);
        const latest = samples[samples.length - 1];
        // 1 h before the first add + 1 h after the return; the 2 days in the team are not waiting
        expect(latest?.waited_seconds).toBeGreaterThanOrEqual(2 * 3600 - 60);
        expect(latest?.waited_seconds).toBeLessThanOrEqual(2 * 3600 + 600);
      });

      it('FR-MATCH-08, ADR-0014: a person who stood in the queue again before the exclusion keeps the new application; the exclusion and the older enqueuedAt move to it', async () => {
        const f = await autoAddedMember(world);
        const otherRole = await freshRole(world);
        await world.ensureCatalog([otherRole]);
        clock.advance(HOUR);
        const second = expectOk<SearchApplicationDto>(
          'createSearchApplication',
          await world.as(f.member).post(MY_APPLICATION, applicationBody([otherRole])),
          201,
        );
        expectOk('excludeTrialMember', await exclude(f), 204);
        await waitFor(async () => (await exclusionTeams(world, second.id)).length > 0, 30_000);
        expect(await exclusionTeams(world, second.id)).toEqual([f.id]);
        const active = expectOk<SearchApplicationDto>(
          'getMySearchApplication',
          await world.as(f.member).get(MY_APPLICATION),
          200,
        );
        expect(active.id).toBe(second.id);
        expect(Date.parse(active.enqueuedAt)).toBeLessThanOrEqual(
          Date.parse(f.application.enqueuedAt),
        );
        expect(await activeApplications(world, f.member.id)).toBe(1);
        expect((await applicationRow(world, f.application.id)).status).toBe('fulfilled');
      });

      it('FR-TEAM-22: a member who did not come from the queue -> 409 NOT_AUTO_ADDED and nothing changes', async () => {
        const f = await autoAddedMember(world, { members: 3 });
        const regular = f.members[0];
        if (!regular) throw new Error('no member');
        expectProblem('excludeTrialMember', await exclude(f, regular.id), 409, 'NOT_AUTO_ADDED');
        expect((await membershipRow(world, f.id, regular.id))?.status).toBe('active');
      });

      it('FR-TEAM-22: after the trial ended -> 409 TRIAL_EXPIRED and the member stays', async () => {
        const f = await autoAddedMember(world);
        clock.advance(TRIAL_MS + 60_000);
        expectProblem('excludeTrialMember', await exclude(f), 409, 'TRIAL_EXPIRED');
        expect((await membershipRow(world, f.id, f.member.id))?.status).toBe('active');
        expect((await applicationRow(world, f.application.id)).status).toBe('fulfilled');
      });

      it('FR-TEAM-22: on the last day the exclusion passes, the next day it is refused (boundary on the fake clock)', async () => {
        const last = await autoAddedMember(world);
        const next = await autoAddedMember(world);
        const lastEnd = Date.parse(last.memberDto.trialUntil ?? '');
        const nextEnd = Date.parse(next.memberDto.trialUntil ?? '');
        const end = Math.max(lastEnd, nextEnd);
        clock.set(end - 1_000);
        expectOk('excludeTrialMember', await exclude(last), 204);
        clock.set(end + 1_000);
        expectProblem('excludeTrialMember', await exclude(next), 409, 'TRIAL_EXPIRED');
      });

      it('FR-TEAM-22: a member of the team who is not the lead -> 403 NOT_TEAM_LEAD', async () => {
        const f = await autoAddedMember(world, { members: 3 });
        const regular = f.members[0];
        if (!regular) throw new Error('no member');
        expectProblem(
          'excludeTrialMember',
          await world.as(regular).delete(`/v1/teams/${f.id}/members/${f.member.id}`),
          403,
          'NOT_TEAM_LEAD',
        );
        expect((await membershipRow(world, f.id, f.member.id))?.status).toBe('active');
      });

      it('FR-TEAM-22: a person who already left -> 404 (userId must be an active member)', async () => {
        const f = await autoAddedMember(world);
        expectOk('leaveTeam', await world.as(f.member).delete(`/v1/teams/${f.id}/members/me`), 204);
        expectProblem('excludeTrialMember', await exclude(f), 404, 'NOT_FOUND');
      });

      it('FR-WORK-08: the same Idempotency-Key replays the stored 204 and does not exclude twice', async () => {
        const f = await autoAddedMember(world);
        const key = randomUUID();
        expect((await exclude(f, f.member.id, key)).statusCode).toBe(204);
        const replay = await exclude(f, f.member.id, key);
        expect(replay.statusCode).toBe(204);
        expectReplayed(replay);
        await waitRestored(f.member);
        expect(await applicationsOf(world, f.member.id)).toHaveLength(1);
        expect(await exclusionTeams(world, f.application.id)).toEqual([f.id]);
      });
    });

    describe('confirmTrial (FR-TEAM-24)', () => {
      it('the lead confirms early: 200 Member with trialUntil null, the exclusion is closed afterwards (409 TRIAL_EXPIRED)', async () => {
        const f = await autoAddedMember(world);
        const confirmed = expectOk<MemberDto>('confirmTrial', await confirm(f), 200);
        expect(confirmed).toMatchObject({
          userId: f.member.id,
          joinedVia: 'auto',
          trialUntil: null,
          status: 'active',
        });
        expect((await membershipRow(world, f.id, f.member.id))?.trial_confirmed_at).not.toBeNull();
        expect((await memberIn(f))?.trialUntil).toBeNull();
        expectProblem('excludeTrialMember', await exclude(f), 409, 'TRIAL_EXPIRED');
      });

      it('FR-TEAM-24: a member who did not come from the queue -> 409 (nothing to confirm)', async () => {
        const f = await autoAddedMember(world, { members: 3 });
        const regular = f.members[0];
        if (!regular) throw new Error('no member');
        const response = await confirm(f, regular.id);
        expect(response.statusCode, response.body).toBe(409);
        expect(['NOT_AUTO_ADDED', 'INVALID_STATE']).toContain(
          response.json<{ code: string }>().code,
        );
      });

      it('FR-TEAM-24: a member of the team who is not the lead -> 403 NOT_TEAM_LEAD', async () => {
        const f = await autoAddedMember(world, { members: 3 });
        const regular = f.members[0];
        if (!regular) throw new Error('no member');
        expectProblem(
          'confirmTrial',
          await world
            .as(regular)
            .post(`/v1/teams/${f.id}/members/${f.member.id}/trial-confirmation`),
          403,
          'NOT_TEAM_LEAD',
        );
        expect((await memberIn(f))?.trialUntil).not.toBeNull();
      });

      it('FR-WORK-08: the same Idempotency-Key replays the stored 200', async () => {
        const f = await autoAddedMember(world);
        const key = randomUUID();
        const first = await confirm(f, f.member.id, key);
        const body = expectOk<MemberDto>('confirmTrial', first, 200);
        const replay = await confirm(f, f.member.id, key);
        expect(replay.statusCode).toBe(200);
        expectReplayed(replay);
        expect(replay.json()).toEqual(body);
      });
    });

    describe('timer trial-expire (FR-TEAM-24)', () => {
      it('fired before the end of the trial it changes nothing', async () => {
        const f = await autoAddedMember(world);
        await fireTrialExpire(world, f.membershipId);
        expect((await memberIn(f))?.trialUntil).toBe(f.memberDto.trialUntil);
      });

      it('fired after the end of the trial the member is a full member: trialUntil is cleared, he stays', async () => {
        const f = await autoAddedMember(world);
        clock.advance(TRIAL_MS + 60_000);
        await fireTrialExpire(world, f.membershipId);
        const member = await waitFor(async () => {
          const m = await memberIn(f);
          return m && m.trialUntil === null ? m : false;
        }, 20_000);
        expect(member).toMatchObject({ status: 'active', joinedVia: 'auto' });
      });
    });

    describe('leaving in the trial (FR-TEAM-23)', () => {
      it('an auto-added member leaves in time: 204, no consequences, the application is NOT restored, no exclusion is recorded', async () => {
        const f = await autoAddedMember(world);
        expectOk('leaveTeam', await world.as(f.member).delete(`/v1/teams/${f.id}/members/me`), 204);
        expect(await membershipRow(world, f.id, f.member.id)).toMatchObject({
          status: 'left',
          left_reason: 'left',
        });
        await runAutoAdd(world);
        await settle();
        expectProblem(
          'getMySearchApplication',
          await world.as(f.member).get(MY_APPLICATION),
          404,
          'APPLICATION_NOT_FOUND',
        );
        expect(await activeApplications(world, f.member.id)).toBe(0);
        expect((await applicationRow(world, f.application.id)).status).toBe('fulfilled');
        expect(await exclusionTeams(world, f.application.id)).toEqual([]);
        expect(await waitSamples(world, f.application.id)).toHaveLength(1);
        expect(await seatStatus(world, f.seat.id)).toBe('open');
      });

      it('FR-TEAM-23: the person who left may stand in the queue again with a new application (a new wait)', async () => {
        const f = await autoAddedMember(world);
        expectOk('leaveTeam', await world.as(f.member).delete(`/v1/teams/${f.id}/members/me`), 204);
        clock.advance(HOUR);
        const again = expectOk<SearchApplicationDto>(
          'createSearchApplication',
          await world.as(f.member).post(MY_APPLICATION, applicationBody([f.roleCode])),
          201,
        );
        expect(again.id).not.toBe(f.application.id);
        expect(Date.parse(again.enqueuedAt)).toBeGreaterThan(Date.parse(f.application.enqueuedAt));
      });
    });
  },
);
