import { afterAll, beforeAll, expect, it } from 'vitest';
import { codesAt, expectReplayOf, fireAll, tally, winnerOf } from '../fixtures/concurrency.js';
import type { UserFixture } from '../fixtures/index.js';
import {
  activeApplications,
  applicationRow,
  exclusionTeams,
  membershipRow,
} from '../fixtures/matching-db.js';
import {
  autoAddedMember,
  fireTrialExpire,
  readTeam,
  type AutoAddedMember,
} from '../fixtures/matching.js';
import { expectNoDeadlocks } from '../fixtures/teams-db.js';
import { World } from '../fixtures/world.js';
import { FakeClock } from '../helpers/clock.js';
import { describeInfra, waitFor } from '../helpers/infra.js';

/*
 * Races of the trial period (docs/architecture.md 12.3, plan S4 "Тесты среза"): exclusion against the
 * end of the trial, against an early confirmation, against the member leaving himself. All of them
 * take #4 team -> #6 `membership FOR UPDATE`; the exclusion checks
 * `trial_until > :now AND trial_confirmed_at IS NULL AND joined_via = 'auto'` under that lock.
 */
describeInfra(
  'Races: exclusion in the trial period (FR-TEAM-22, -23, -24, FR-MATCH-08)',
  ['db', 'redis'],
  () => {
    let world: World;
    const clock = new FakeClock(Date.now());
    let deadlocksBefore = 0;

    beforeAll(async () => {
      world = await World.start({ clock });
      await world.ensureCatalog(['backend', 'frontend', 'pm', 'designer', 'qa', 'devops']);
      deadlocksBefore = await world.deadlocks();
    });

    afterAll(async () => {
      if (!world) return;
      await expectNoDeadlocks(world, deadlocksBefore);
      await world.close();
    });

    const excludeUrl = (f: AutoAddedMember): string => `/v1/teams/${f.id}/members/${f.member.id}`;
    const confirmUrl = (f: AutoAddedMember): string => `${excludeUrl(f)}/trial-confirmation`;
    const trialEnd = (f: AutoAddedMember): number => Date.parse(f.memberDto.trialUntil ?? '');
    const restored = async (user: UserFixture): Promise<boolean> =>
      (await world.as(user).get('/v1/me/search-application')).statusCode === 200;

    it('exclusion against the expiry of the trial: the clock is past the end, the timer and the exclusion fire together -> the exclusion is refused TRIAL_EXPIRED, the member stays, the application is not restored', async () => {
      for (let round = 0; round < 3; round += 1) {
        const f = await autoAddedMember(world);
        clock.set(trialEnd(f) + 1);
        const fired = await Promise.all([
          fireAll(1, (_i, key) => world.as(f.lead).delete(excludeUrl(f), { idempotencyKey: key })),
          fireTrialExpire(world, f.membershipId),
        ]);
        const exclusion = fired[0][0];
        expect(exclusion?.status).toBe(409);
        expect(exclusion?.code).toBe('TRIAL_EXPIRED');
        expect((await membershipRow(world, f.id, f.member.id))?.status).toBe('active');
        expect((await applicationRow(world, f.application.id)).status).toBe('fulfilled');
        expect(await exclusionTeams(world, f.application.id)).toEqual([]);
        expect(await restored(f.member)).toBe(false);
        const member = (await readTeam(world, f.lead, f.id)).members.find(
          (m) => m.userId === f.member.id,
        );
        expect(member).toMatchObject({ status: 'active', joinedVia: 'auto' });
      }
    });

    it('exclusion against the timer a moment before the end of the trial -> the exclusion wins (204), the timer finds nothing to do', async () => {
      for (let round = 0; round < 3; round += 1) {
        const f = await autoAddedMember(world);
        clock.set(trialEnd(f) - 1_000);
        const [fired] = await Promise.all([
          fireAll(1, (_i, key) => world.as(f.lead).delete(excludeUrl(f), { idempotencyKey: key })),
          fireTrialExpire(world, f.membershipId),
        ]);
        expect(fired[0]?.status).toBe(204);
        expect((await membershipRow(world, f.id, f.member.id))?.status).toBe('removed');
        await waitFor(() => restored(f.member), 30_000);
        expect(await activeApplications(world, f.member.id)).toBe(1);
        expect(await exclusionTeams(world, f.application.id)).toEqual([f.id]);
      }
    });

    it('5 parallel exclusions of one member -> 1 x 204, 4 x 404 (no longer an active member), the application comes back once', async () => {
      const f = await autoAddedMember(world);
      const fired = await fireAll(5, (_i, key) =>
        world.as(f.lead).delete(excludeUrl(f), { idempotencyKey: key }),
      );
      expect(tally(fired)).toEqual({ 204: 1, 404: 4 });
      await waitFor(() => restored(f.member), 30_000);
      expect(await activeApplications(world, f.member.id)).toBe(1);
      expect(await exclusionTeams(world, f.application.id)).toEqual([f.id]);
      expectReplayOf(
        winnerOf(fired, 204),
        await world.as(f.lead).delete(excludeUrl(f), { idempotencyKey: winnerOf(fired, 204).key }),
      );
      expect(await activeApplications(world, f.member.id)).toBe(1);
    });

    it('exclusion against an early confirmation -> exactly one wins: the member is removed (the confirmation gets 404) or confirmed (every exclusion gets 409 TRIAL_EXPIRED)', async () => {
      for (let round = 0; round < 4; round += 1) {
        const f = await autoAddedMember(world);
        const [exclusions, confirmations] = await Promise.all([
          fireAll(3, (_i, key) => world.as(f.lead).delete(excludeUrl(f), { idempotencyKey: key })),
          fireAll(1, (_i, key) =>
            world.as(f.lead).post(confirmUrl(f), undefined, { idempotencyKey: key }),
          ),
        ]);
        const confirmation = confirmations[0];
        const row = await membershipRow(world, f.id, f.member.id);
        if (confirmation?.status === 200) {
          expect(tally(exclusions)).toEqual({ 409: 3 });
          expect(codesAt(exclusions, 409)).toEqual(['TRIAL_EXPIRED']);
          expect(row).toMatchObject({ status: 'active' });
          expect(row?.trial_confirmed_at).not.toBeNull();
          expect(await restored(f.member)).toBe(false);
        } else {
          expect(confirmation?.status).toBe(404);
          expect(tally(exclusions)).toEqual({ 204: 1, 404: 2 });
          expect(row).toMatchObject({ status: 'removed', left_reason: 'removed_in_trial' });
          expect(row?.trial_confirmed_at).toBeNull();
          await waitFor(() => restored(f.member), 30_000);
        }
      }
    });

    it('FR-TEAM-23: exclusion against the member leaving himself -> the application comes back only if the exclusion won', async () => {
      for (let round = 0; round < 4; round += 1) {
        const f = await autoAddedMember(world);
        const [exclusion, leave] = await Promise.all([
          fireAll(1, (_i, key) => world.as(f.lead).delete(excludeUrl(f), { idempotencyKey: key })),
          fireAll(1, (_i, key) =>
            world.as(f.member).delete(`/v1/teams/${f.id}/members/me`, { idempotencyKey: key }),
          ),
        ]);
        const row = await membershipRow(world, f.id, f.member.id);
        if (exclusion[0]?.status === 204) {
          expect(leave[0]?.status).toBe(404);
          expect(row).toMatchObject({ status: 'removed', left_reason: 'removed_in_trial' });
          await waitFor(() => restored(f.member), 30_000);
        } else {
          expect(exclusion[0]?.status).toBe(404);
          expect(leave[0]?.status).toBe(204);
          expect(row).toMatchObject({ status: 'left', left_reason: 'left' });
          await new Promise((resolve) => setTimeout(resolve, 1_500));
          expect(await restored(f.member)).toBe(false);
          expect(await exclusionTeams(world, f.application.id)).toEqual([]);
        }
      }
    });
  },
);
