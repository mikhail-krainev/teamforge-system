import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { codesAt, expectReplayOf, fireAll, tally, winnerOf } from '../fixtures/concurrency.js';
import {
  authorshipCount,
  closeWindow,
  createReview,
  receivedOk,
  reviewCountFor,
  reviewRows,
  waitEligibility,
  REVIEW_WINDOW_MS,
} from '../fixtures/reviews.js';
import { completedProject, membersOf, type Project } from '../fixtures/rewards.js';
import { startRewardsWorld, type RewardsWorld } from '../fixtures/rewards-world.js';
import { notificationCount, expectNoDeadlocks } from '../fixtures/teams-db.js';
import { clockOf } from '../fixtures/workspace.js';
import { describeInfra } from '../helpers/infra.js';

/*
 * The races of the peer reviews (FR-PROF-08, SEC-04; docs/plan.md S7-07 "Проверка"; architecture 5.4 "Отзывы",
 * 12.3): `createPeerReview` is one transaction `INSERT peer_review` + `INSERT peer_review_authorship` and the
 * unique index `peer_review_pair_uq (team_id, author_user_id, subject_user_id)` decides a race of one pair:
 * 20 requests -> 1 x 201, 19 x 409 REVIEW_EXISTS. The publication `review-publish` runs in one transaction per
 * team and publishes a batch once, however many jobs start. The job payload is the assumption of fixtures/reviews.ts.
 */

const N = 20;

describeInfra(
  'CC (S7-07): parallel reviews of one pair and parallel publication',
  ['db', 'redis', 's3'],
  () => {
    let rw: RewardsWorld;
    let deadlocksBefore = 0;

    beforeAll(async () => {
      rw = await startRewardsWorld();
      deadlocksBefore = await rw.world.deadlocks();
    }, 120_000);

    afterAll(async () => {
      if (!rw) return;
      await expectNoDeadlocks(rw.world, deadlocksBefore);
      await rw.close();
    });

    const reviewable = async (): Promise<Project> => {
      const project = await completedProject(rw.world);
      await waitEligibility(rw.world, project.fx.team.id, membersOf(project));
      return project;
    };

    it('FR-PROF-08: 20 parallel reviews of one pair with different keys -> 1 x 201, 19 x 409 REVIEW_EXISTS; one review, one authorship row', async () => {
      const p = await reviewable();
      const teamId = p.fx.team.id;
      const fired = await fireAll(N, (_i, key) =>
        createReview(
          rw.world,
          p.lead,
          teamId,
          p.backend.id,
          'Отзыв из параллельного запроса.',
          key,
        ),
      );
      expect(tally(fired)).toEqual({ 201: 1, 409: N - 1 });
      expect(codesAt(fired, 409)).toEqual(['REVIEW_EXISTS']);
      expect(await reviewCountFor(rw.world, teamId, p.backend.id)).toBe(1);
      expect(await authorshipCount(rw.world, teamId)).toBe(1);
      expect(await receivedOk(rw.world, p.backend)).toEqual([]);
    }, 300_000);

    it('FR-PROF-08 (paired): the winner repeats his key -> the stored 201 with Idempotent-Replayed; a loser repeats his -> the stored 409', async () => {
      const p = await reviewable();
      const teamId = p.fx.team.id;
      const fired = await fireAll(5, (_i, key) =>
        createReview(rw.world, p.lead, teamId, p.backend.id, 'Парный отзыв.', key),
      );
      const winner = winnerOf(fired, 201);
      const loser = winnerOf(fired, 409);
      expectReplayOf(
        winner,
        await createReview(rw.world, p.lead, teamId, p.backend.id, 'Парный отзыв.', winner.key),
      );
      expectReplayOf(
        loser,
        await createReview(rw.world, p.lead, teamId, p.backend.id, 'Парный отзыв.', loser.key),
      );
      expect(await reviewCountFor(rw.world, teamId, p.backend.id)).toBe(1);
    }, 300_000);

    it('FR-PROF-08: 20 reviews of one pair with ONE key -> one stored answer for all, one review', async () => {
      const p = await reviewable();
      const key = randomUUID();
      const fired = await fireAll(
        N,
        (_i, k) =>
          createReview(
            rw.world,
            p.lead,
            p.fx.team.id,
            p.backend.id,
            'Один ключ на все запросы.',
            k,
          ),
        Array.from({ length: N }, () => key),
      );
      expect(fired.every((f) => f.status === 201 || f.status === 409)).toBe(true);
      expect(fired.filter((f) => f.status === 201).length).toBeGreaterThanOrEqual(1);
      expect(await reviewCountFor(rw.world, p.fx.team.id, p.backend.id)).toBe(1);
    }, 300_000);

    it('FR-PROF-08: two different authors write about the same person at once -> both 201, two reviews, two authorship rows', async () => {
      const p = await reviewable();
      const [one, two] = await Promise.all([
        createReview(
          rw.world,
          p.lead,
          p.fx.team.id,
          p.backend.id,
          'Первый автор пишет одновременно.',
        ),
        createReview(
          rw.world,
          p.frontend,
          p.fx.team.id,
          p.backend.id,
          'Второй автор пишет одновременно.',
        ),
      ]);
      expect([one.statusCode, two.statusCode]).toEqual([201, 201]);
      expect(await reviewCountFor(rw.world, p.fx.team.id, p.backend.id)).toBe(2);
      expect(await authorshipCount(rw.world, p.fx.team.id)).toBe(2);
    }, 300_000);

    it('FR-PROF-08: 20 reviews of one pair after the window closed -> 20 x 409 REVIEW_WINDOW_CLOSED, nothing is stored', async () => {
      const p = await reviewable();
      clockOf(rw.world).advance(REVIEW_WINDOW_MS + 3_600_000);
      const fired = await fireAll(N, (_i, key) =>
        createReview(rw.world, p.lead, p.fx.team.id, p.backend.id, 'Слишком поздно.', key),
      );
      expect(tally(fired)).toEqual({ 409: N });
      expect(codesAt(fired, 409)).toEqual(['REVIEW_WINDOW_CLOSED']);
      expect(await reviewRows(rw.world, p.fx.team.id)).toEqual([]);
    }, 300_000);

    it('SEC-04: 20 publication jobs of one team at once publish the batch once: one date, one notification, nothing published twice', async () => {
      const p = await reviewable();
      const teamId = p.fx.team.id;
      expect(
        (await createReview(rw.world, p.lead, teamId, p.backend.id, 'Первый отзыв пакета.'))
          .statusCode,
      ).toBe(201);
      expect(
        (await createReview(rw.world, p.frontend, teamId, p.backend.id, 'Второй отзыв пакета.'))
          .statusCode,
      ).toBe(201);
      const notificationsBefore = await notificationCount(rw.world, p.backend.id);
      const outcomes = await closeWindow(rw.world, teamId, N);
      expect(outcomes).toHaveLength(N);
      expect(outcomes.some((o) => o.state === 'completed')).toBe(true);
      const rows = await reviewRows(rw.world, teamId);
      expect(rows.map((r) => r.status)).toEqual(['published', 'published']);
      expect(new Set(rows.map((r) => r.published_on)).size).toBe(1);
      expect((await receivedOk(rw.world, p.backend)).length).toBe(2);
      expect(await notificationCount(rw.world, p.backend.id)).toBe(notificationsBefore + 1);
    }, 300_000);

    it('SEC-04: the publication of a subject with one author at the same moment as 20 more jobs withholds it once and never publishes it', async () => {
      const p = await reviewable();
      const teamId = p.fx.team.id;
      expect(
        (await createReview(rw.world, p.lead, teamId, p.frontend.id, 'Единственный отзыв.'))
          .statusCode,
      ).toBe(201);
      await closeWindow(rw.world, teamId, N);
      const rows = await reviewRows(rw.world, teamId);
      expect(rows.map((r) => r.status)).toEqual(['withheld']);
      expect(await receivedOk(rw.world, p.frontend)).toEqual([]);
    }, 300_000);
  },
);
