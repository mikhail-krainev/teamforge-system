import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { UserFixture } from '../../../../test/fixtures/index.js';
import {
  authorshipOf,
  closeWindow,
  createReview,
  receivedOk,
  reviewCountFor,
  reviewRows,
  runEligibilityScan,
  runReviewPurge,
  sentOk,
  REVIEW_WINDOW_MS,
} from '../../../../test/fixtures/reviews.js';
import {
  awardsOk,
  countersOk,
  endCooling,
  membersOf,
  waitCreditRun,
  type Project,
} from '../../../../test/fixtures/rewards.js';
import {
  counterRowCount,
  creditRows,
  projectCreditRows,
} from '../../../../test/fixtures/rewards-db.js';
import { DAY } from '../../../../test/fixtures/teams.js';
import { clockOf } from '../../../../test/fixtures/workspace.js';
import { describeInfra, waitFor } from '../../../../test/helpers/infra.js';
import {
  markedText,
  reviewProject,
  startReviewWorld,
  type ReviewWorld,
} from './reviews-support.js';

/*
 * S7-07 (written before the implementation): the life of the review data around the project (FR-PROF-08, FR-REW-13,
 * FR-AUTH-09, Р-20; architecture 5.3, 5.4, 10.1 "review-eligibility-scan", 15 "сага удаления"):
 *   1. the right to write comes from `workspace.project_completed`; the scanner `review-eligibility-scan` repairs a
 *      lost event;
 *   2. reviews do not touch rewards: credit, counters and awards are the same before and after reviews are written,
 *      published, purged (FR-REW-13);
 *   3. the erasure of an AUTHOR deletes his rows of `peer_review_authorship` and leaves the text with the subject;
 *      the erasure of a SUBJECT deletes the reviews about him.
 * L = lead, B = backend, F = frontend of one credited project; the clock is shared by the API and the worker.
 */

const HOUR = 3_600_000;

interface Standing {
  counters: Record<string, number>;
  awards: Record<string, string[]>;
  credits: number;
  projectCredits: number;
}

describeInfra(
  'S7 profiles: review eligibility, rewards stay apart, erasure (FR-PROF-08, FR-REW-13)',
  ['db', 'redis', 's3'],
  () => {
    let rw: ReviewWorld;
    let project: Project;
    let teamId: string;
    let before: Standing;

    beforeAll(async () => {
      rw = await startReviewWorld();
      project = await reviewProject(rw);
      teamId = project.fx.team.id;
    }, 300_000);

    afterAll(async () => {
      if (rw) await rw.close();
    });

    const [lead, backend, frontend] = [
      (): UserFixture => project.lead,
      (): UserFixture => project.backend,
      (): UserFixture => project.frontend,
    ];

    /** What rewards holds for the three people: the counters, the names of the awards, the rows of credit. */
    async function standing(): Promise<Standing> {
      const counters: Record<string, number> = {};
      const awards: Record<string, string[]> = {};
      for (const member of membersOf(project)) {
        counters[member.id] = (await countersOk(rw.world, lead(), member.id)).total;
        awards[member.id] = (await awardsOk(rw.world, lead(), member.id)).map((a) => a.name).sort();
      }
      return {
        counters,
        awards,
        credits: (await creditRows(rw.world, teamId)).length,
        projectCredits: (await projectCreditRows(rw.world, teamId)).length,
      };
    }

    async function eraseAccount(user: UserFixture): Promise<void> {
      const response = await rw.world
        .as(user)
        .post('/v1/me/deletion-requests', { reason: 'user_request', confirm: true });
      expect(response.statusCode, response.body).toBe(202);
      clockOf(rw.world).advance(72 * HOUR + 60_000);
      await rw.world.runMaintenance('deletion-scheduler');
      await waitFor(async () => {
        const rows = await rw.world.sql<{ status: string }[]>`
        SELECT status FROM auth.deletion_request WHERE user_id = ${user.id}`;
        return rows[0]?.status === 'completed';
      }, 60_000);
    }

    describe('the right to write (FR-PROF-08, C-27)', () => {
      it('FR-PROF-08: the completion gives every participant a review_eligibility row with the project name and the window of 14 days', async () => {
        const rows = await rw.world.sql<
          { user_id: string; team_name: string; window_until: Date }[]
        >`
        SELECT user_id, team_name, window_until FROM profiles.review_eligibility WHERE team_id = ${teamId}`;
        expect(rows.map((r) => r.user_id).sort()).toEqual(
          membersOf(project)
            .map((m) => m.id)
            .sort(),
        );
        const completedAt = Date.parse(project.completion?.completedAt ?? '');
        for (const row of rows) {
          expect(row.team_name).toBe(project.fx.team.dto.name);
          expect(row.window_until.getTime()).toBe(completedAt + REVIEW_WINDOW_MS);
        }
      });

      it('FR-PROF-08: a lost event is repaired by review-eligibility-scan: the rows come back, once each, and a second run adds none', async () => {
        await rw.world.sql`DELETE FROM profiles.review_eligibility WHERE team_id = ${teamId}`;
        clockOf(rw.world).advance(11 * 60_000);
        await runEligibilityScan(rw.world);
        const count = async (): Promise<number> =>
          (
            await rw.world.sql<
              { n: number }[]
            >`SELECT count(*)::int AS n FROM profiles.review_eligibility WHERE team_id = ${teamId}`
          )[0]?.n ?? 0;
        expect(await count()).toBe(3);
        await runEligibilityScan(rw.world);
        expect(await count()).toBe(3);
        expect(
          (await createReview(rw.world, lead(), teamId, backend().id, markedText('scan')))
            .statusCode,
        ).toBe(201);
      });
    });

    describe('reviews do not move the rewards (FR-REW-13)', () => {
      beforeAll(async () => {
        await endCooling(project);
        await waitCreditRun(rw.world, teamId, 'credited');
        before = await standing();
      }, 180_000);

      it('FR-REW-13: the project is credited and the three people have counters and awards to compare', () => {
        expect(Object.values(before.counters).some((v) => v > 0)).toBe(true);
        expect(before.credits).toBeGreaterThan(0);
      });

      it('FR-REW-13: writing reviews (two authors for B, one for F) changes neither credit nor counters nor awards', async () => {
        expect(
          (await createReview(rw.world, frontend(), teamId, backend().id, markedText('fb')))
            .statusCode,
        ).toBe(201);
        expect(
          (await createReview(rw.world, backend(), teamId, frontend().id, markedText('bf')))
            .statusCode,
        ).toBe(201);
        expect(await standing()).toEqual(before);
      });

      it('FR-REW-13: publishing the batch and the withholding change nothing in rewards', async () => {
        await closeWindow(rw.world, teamId);
        expect((await receivedOk(rw.world, backend())).length).toBe(2);
        expect(await receivedOk(rw.world, frontend())).toEqual([]);
        expect(await standing()).toEqual(before);
      });

      it('FR-REW-13: the purge of the withheld review changes nothing in rewards either', async () => {
        clockOf(rw.world).advance(31 * DAY);
        await runReviewPurge(rw.world);
        expect(await reviewCountFor(rw.world, teamId, frontend().id)).toBe(0);
        expect(await standing()).toEqual(before);
      });
    });

    describe('the erasure of an account (FR-AUTH-09, Р-20, SEC-04)', () => {
      it('Р-20: the author is erased: his authorship rows go, the reviews stay with the subject, the subject still sees both and no name', async () => {
        expect(await authorshipOf(rw.world, frontend().id)).toBeGreaterThan(0);
        const textsBefore = (await receivedOk(rw.world, backend())).map((i) => i.text).sort();
        await eraseAccount(frontend());
        expect(await authorshipOf(rw.world, frontend().id)).toBe(0);
        const after = await receivedOk(rw.world, backend());
        expect(after.map((i) => i.text).sort()).toEqual(textsBefore);
        expect(JSON.stringify(after)).not.toContain(frontend().displayName);
        expect(
          (await reviewRows(rw.world, teamId)).filter((r) => r.subject_user_id === backend().id),
        ).toHaveLength(2);
      });

      it('Р-20: the erasure of one author leaves the sent list of another author intact', async () => {
        const mine = await sentOk(rw.world, lead(), teamId);
        expect(mine.items.map((i) => i.subjectUserId)).toContain(backend().id);
      });

      it('FR-AUTH-09, SEC-04: the subject is erased: the reviews about him and their authorship are deleted, the others stay', async () => {
        const countBefore = (await reviewRows(rw.world, teamId)).length;
        expect(await reviewCountFor(rw.world, teamId, backend().id)).toBe(2);
        await eraseAccount(backend());
        expect(await reviewCountFor(rw.world, teamId, backend().id)).toBe(0);
        const orphans = await rw.world.sql<{ n: number }[]>`
        SELECT count(*)::int AS n FROM profiles.peer_review_authorship a
         WHERE NOT EXISTS (SELECT 1 FROM profiles.peer_review r WHERE r.id = a.review_id)`;
        expect(orphans[0]?.n).toBe(0);
        expect((await reviewRows(rw.world, teamId)).length).toBe(countBefore - 2);
      });

      it("FR-REW-13: the erasure of the subject removes his own rewards and leaves the lead's ones as they were", async () => {
        expect(await counterRowCount(rw.world, backend().id)).toBe(0);
        expect((await countersOk(rw.world, lead(), lead().id)).total).toBe(
          before.counters[lead().id],
        );
        expect((await awardsOk(rw.world, lead(), lead().id)).map((a) => a.name).sort()).toEqual(
          before.awards[lead().id],
        );
      });
    });
  },
);
