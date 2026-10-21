import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { expectProblem, expectReplayed } from '../../../../test/fixtures/assertions.js';
import {
  authorshipCount,
  closeWindow,
  createReview,
  expectUuidV4,
  receivedOk,
  receivedReviews,
  reviewCountFor,
  reviewRows,
  REVIEW_WINDOW_MS,
  runReviewPurge,
  sentOk,
  sentReviews,
  type ReviewSentDto,
} from '../../../../test/fixtures/reviews.js';
import { runJobs, type Project } from '../../../../test/fixtures/rewards.js';
import { expectOk, DAY } from '../../../../test/fixtures/teams.js';
import { notificationCount } from '../../../../test/fixtures/teams-db.js';
import { clockOf } from '../../../../test/fixtures/workspace.js';
import { expectMatchesContract } from '../../../../test/helpers/contract.js';
import { describeInfra } from '../../../../test/helpers/infra.js';
import {
  markedText,
  reviewProject,
  startReviewWorld,
  type ReviewWorld,
} from './reviews-support.js';

/*
 * S7-07 (written before the implementation): the peer reviews of FR-PROF-08 as SEC-04 changed them
 * (docs/spec.md 4.2; architecture 5.3, 5.4 "Отзывы"): createPeerReview, listReceivedReviews, listSentReviews.
 * One project of three people (L = lead, B = backend, F = frontend) runs through the whole life of its reviews:
 *   L -> B, F -> B : B gets reviews from 2 authors  -> published as a batch after the window;
 *   L -> F         : F gets a review from 1 author -> withheld, never shown, purged 30 days later.
 * The tests of one block depend on the earlier ones (the state of the project), like the other multi-step
 * suites. IDOR is in reviews-idor.test.ts, the lifecycle (scan, erasure, FR-REW-13) in reviews-lifecycle.test.ts.
 *
 * ASSUMPTIONS (the contract leaves them open): the publication is the job `review-publish` of `timers` with
 * `{ teamId }`, the purge `review-purge` of `maintenance` (fixtures/reviews.ts); the creation of a review in a
 * closed window is 409 REVIEW_WINDOW_CLOSED (the contract; the plan says "410/409"); the notification "получены
 * отзывы" is the only notification of the whole story and is created at the publication.
 */

const MARKER = randomUUID().slice(0, 8);
const MARKUP = '<script>alert(1)</script><img src=x onerror=alert(2)>';
const BATCH_KEYS = ['id', 'publishedOn', 'teamId', 'teamName', 'text'];

describeInfra('S7 profiles: peer reviews, SEC-04 (FR-PROF-08)', ['db', 'redis', 's3'], () => {
  let rw: ReviewWorld;
  let project: Project;
  let teamId: string;
  let completedDay: string;
  let createdDay: string;
  let outboxBefore = 0;

  beforeAll(async () => {
    rw = await startReviewWorld();
    project = await reviewProject(rw);
    teamId = project.fx.team.id;
    completedDay = new Date(Date.parse(project.completion?.completedAt ?? '') + REVIEW_WINDOW_MS)
      .toISOString()
      .slice(0, 10);
    createdDay = clockOf(rw.world).now().toISOString().slice(0, 10);
    outboxBefore = await reviewOutbox();
  }, 300_000);

  afterAll(async () => {
    if (rw) await rw.close();
  });

  const lead = (): Project['lead'] => project.lead;
  const backend = (): Project['backend'] => project.backend;
  const frontend = (): Project['frontend'] => project.frontend;

  async function reviewOutbox(): Promise<number> {
    const rows = await rw.world.sql<{ n: number }[]>`
      SELECT count(*)::int AS n FROM platform.outbox_event
       WHERE module = 'profiles' AND type ILIKE '%review%'`;
    return rows[0]?.n ?? 0;
  }

  describe('writing a review in the window (FR-PROF-08, C-27)', () => {
    it('FR-PROF-08: the author gets 201 with the subject and "sent" only; the review is pending with a random UUID v4', async () => {
      const notificationsBefore = await notificationCount(rw.world, backend().id);
      const response = await createReview(
        rw.world,
        lead(),
        teamId,
        backend().id,
        markedText(`${MARKER}-lb`),
      );
      const body = expectOk<ReviewSentDto>('createPeerReview', response, 201);
      expect(body).toEqual({ subjectUserId: backend().id, status: 'sent' });
      const rows = (await reviewRows(rw.world, teamId)).filter(
        (r) => r.subject_user_id === backend().id,
      );
      expect(rows).toHaveLength(1);
      expect(rows[0]?.status).toBe('pending');
      expect(rows[0]?.published_on).toBeNull();
      expectUuidV4(rows[0]?.id ?? '');
      expect(await authorshipCount(rw.world, teamId)).toBe(1);
      expect(await notificationCount(rw.world, backend().id)).toBe(notificationsBefore);
    });

    it('SEC-04 (5): the text of the review lives in a table without any author column', async () => {
      const columns = await rw.world.sql<{ column_name: string }[]>`
        SELECT column_name FROM information_schema.columns
         WHERE table_schema = 'profiles' AND table_name = 'peer_review'`;
      expect(columns.length).toBeGreaterThan(0);
      expect(columns.map((c) => c.column_name).filter((n) => /author|created/i.test(n))).toEqual(
        [],
      );
    });

    it('FR-PROF-08: a second author for the same subject and a second subject for the same author are both fine', async () => {
      const second = await createReview(
        rw.world,
        frontend(),
        teamId,
        backend().id,
        `${markedText(`${MARKER}-fb`)} ${MARKUP}`,
      );
      expectOk('createPeerReview', second, 201);
      const third = await createReview(
        rw.world,
        lead(),
        teamId,
        frontend().id,
        markedText(`${MARKER}-lf`),
      );
      expectOk('createPeerReview', third, 201);
      expect(await reviewCountFor(rw.world, teamId, backend().id)).toBe(2);
      expect(await reviewCountFor(rw.world, teamId, frontend().id)).toBe(1);
      expect(await authorshipCount(rw.world, teamId)).toBe(3);
    });

    it('SEC-04 (1): no notification, no outbox event, no realtime message is created by a review', async () => {
      expect(await reviewOutbox()).toBe(outboxBefore);
      for (const person of [backend(), frontend(), lead()]) {
        const feed = await rw.world.as(person).get('/v1/me/notifications');
        expect(feed.body).not.toMatch(/отзыв/i);
      }
    });

    it('FR-PROF-08: a second review of the same pair -> 409 REVIEW_EXISTS, nothing is added', async () => {
      const again = await createReview(
        rw.world,
        lead(),
        teamId,
        backend().id,
        'Другой текст отзыва, второй раз.',
      );
      expectProblem('createPeerReview', again, 409, 'REVIEW_EXISTS');
      expect(await reviewCountFor(rw.world, teamId, backend().id)).toBe(2);
      expect(await authorshipCount(rw.world, teamId)).toBe(3);
    });

    it('FR-PROF-08 (paired): the same key repeated -> the stored 201 with Idempotent-Replayed; the stored 409 is replayed too', async () => {
      const key = randomUUID();
      const first = await createReview(
        rw.world,
        backend(),
        teamId,
        frontend().id,
        markedText(`${MARKER}-bf`),
        key,
      );
      expectOk('createPeerReview', first, 201);
      const replay = await createReview(
        rw.world,
        backend(),
        teamId,
        frontend().id,
        markedText(`${MARKER}-bf`),
        key,
      );
      expect(replay.statusCode).toBe(201);
      expectReplayed(replay);
      expect(replay.json()).toEqual(first.json());
      expect(await reviewCountFor(rw.world, teamId, frontend().id)).toBe(2);
      const conflictKey = randomUUID();
      const loser = await createReview(
        rw.world,
        backend(),
        teamId,
        frontend().id,
        'Повторный отзыв.',
        conflictKey,
      );
      expectProblem('createPeerReview', loser, 409, 'REVIEW_EXISTS');
      const loserReplay = await createReview(
        rw.world,
        backend(),
        teamId,
        frontend().id,
        'Повторный отзыв.',
        conflictKey,
      );
      expect(loserReplay.statusCode).toBe(409);
      expectReplayed(loserReplay);
    });

    it('FR-PROF-08: about yourself -> 422; empty text, text above 2000 characters or an unknown field -> 400 VALIDATION_FAILED', async () => {
      const self = await createReview(
        rw.world,
        lead(),
        teamId,
        lead().id,
        'Я отлично поработал над проектом.',
      );
      expect(self.statusCode, self.body).toBe(422);
      expectMatchesContract('createPeerReview', self);
      expectProblem(
        'createPeerReview',
        await createReview(rw.world, frontend(), teamId, lead().id, ''),
        400,
        'VALIDATION_FAILED',
      );
      expectProblem(
        'createPeerReview',
        await createReview(rw.world, frontend(), teamId, lead().id, 'а'.repeat(2001)),
        400,
        'VALIDATION_FAILED',
      );
      const extra = await rw.world.as(frontend()).post(`/v1/teams/${teamId}/reviews`, {
        subjectUserId: lead().id,
        text: 'Хороший отзыв',
        authorId: frontend().id,
      });
      expectProblem('createPeerReview', extra, 400, 'VALIDATION_FAILED');
      expect(await reviewCountFor(rw.world, teamId, lead().id)).toBe(0);
    });

    it('FR-PROF-08: a text of exactly 2000 characters is accepted', async () => {
      const response = await createReview(
        rw.world,
        frontend(),
        teamId,
        lead().id,
        'б'.repeat(2000),
      );
      expectOk('createPeerReview', response, 201);
      expect(await reviewCountFor(rw.world, teamId, lead().id)).toBe(1);
    });

    it('SEC-04: neither the text nor the subject of a review is written to the application log', async () => {
      const lines = rw.world.logs.filter(
        (l) => l.includes(MARKER) || (l.includes('/reviews') && l.includes(backend().id)),
      );
      expect(lines).toEqual([]);
    });
  });

  describe('before the window closes: the subject sees nothing (SEC-04 (1))', () => {
    it('SEC-04 (1): with reviews of two authors written, the list of the subject is empty', async () => {
      for (const person of [backend(), frontend(), lead()]) {
        expect(await receivedOk(rw.world, person)).toEqual([]);
      }
    });

    it('FR-PROF-08: the author sees the fact of sending only, with the end of the window and without any text', async () => {
      const mine = await sentOk(rw.world, lead(), teamId);
      expect(mine.items.map((i) => i.subjectUserId).sort()).toEqual(
        [backend().id, frontend().id].sort(),
      );
      expect(mine.items.every((i) => i.status === 'sent')).toBe(true);
      expect(new Date(mine.windowClosesAt).getTime()).toBe(
        Date.parse(project.completion?.completedAt ?? '') + REVIEW_WINDOW_MS,
      );
      expect(JSON.stringify(mine)).not.toContain(MARKER);
      const others = await sentOk(rw.world, backend(), teamId);
      expect(others.items.map((i) => i.subjectUserId)).toEqual([frontend().id]);
    });

    it('SEC-04: a run of the publication job before the end of the window changes nothing', async () => {
      await runJobs(rw.world, 'timers', 'review-publish', { teamId }, 1, teamId);
      expect((await reviewRows(rw.world, teamId)).every((r) => r.status === 'pending')).toBe(true);
      expect(await receivedOk(rw.world, backend())).toEqual([]);
    });

    it('FR-PROF-08: after the window a new review is refused: 409 REVIEW_WINDOW_CLOSED', async () => {
      clockOf(rw.world).advance(REVIEW_WINDOW_MS + 3_600_000);
      const late = await createReview(
        rw.world,
        backend(),
        teamId,
        lead().id,
        'Поздний отзыв после окна.',
      );
      expectProblem('createPeerReview', late, 409, 'REVIEW_WINDOW_CLOSED');
      expect(await reviewCountFor(rw.world, teamId, lead().id)).toBe(1);
    });
  });

  describe('the batch after the window (SEC-04 (2), (3), (4))', () => {
    let notificationsBefore: number;

    beforeAll(async () => {
      notificationsBefore = await notificationCount(rw.world, backend().id);
      const outcome = await runJobs(rw.world, 'timers', 'review-publish', { teamId }, 1, teamId);
      expect(
        outcome.every((o) => o.state === 'completed'),
        JSON.stringify(outcome),
      ).toBe(true);
    }, 120_000);

    it('SEC-04 (2): subjects with 2 authors (B and F) are published; the subject with 1 author (L) is withheld with purge_after = window + 30 days', async () => {
      const rows = await reviewRows(rw.world, teamId);
      const statusesOf = (userId: string): string[] =>
        rows.filter((r) => r.subject_user_id === userId).map((r) => r.status);
      expect(statusesOf(backend().id)).toEqual(['published', 'published']);
      expect(statusesOf(frontend().id)).toEqual(['published', 'published']);
      expect(statusesOf(lead().id)).toEqual(['withheld']);
      const purge = new Date(Date.parse(`${completedDay}T00:00:00Z`) + 30 * DAY)
        .toISOString()
        .slice(0, 10);
      expect(rows.find((r) => r.status === 'withheld')?.purge_after).toBe(purge);
      expect(
        rows.filter((r) => r.status === 'published').every((r) => r.purge_after === null),
      ).toBe(true);
    });

    it('SEC-04 (2): the subject with 2 authors sees both reviews, with the project name', async () => {
      const items = await receivedOk(rw.world, backend());
      expect(items).toHaveLength(2);
      const text = items.map((i) => i.text).join('\n');
      expect(text).toContain(`${MARKER}-lb`);
      expect(text).toContain(`${MARKER}-fb`);
      expect(
        items.every((i) => i.teamId === teamId && i.teamName === project.fx.team.dto.name),
      ).toBe(true);
    });

    it('SEC-04 (2): the subject with one author sees nothing; the other two see their two reviews', async () => {
      expect(await receivedOk(rw.world, lead())).toEqual([]);
      expect((await receivedOk(rw.world, frontend())).length).toBe(2);
    });

    it('SEC-04 (3): every review of the batch has the day the window closed, not the day it was written', async () => {
      const items = await receivedOk(rw.world, backend());
      expect(new Set(items.map((i) => i.publishedOn))).toEqual(new Set([completedDay]));
      expect(completedDay).not.toBe(createdDay);
      expect(
        (await reviewRows(rw.world, teamId))
          .filter((r) => r.status === 'published')
          .every((r) => r.published_on === completedDay),
      ).toBe(true);
    });

    it('SEC-04 (4): the id of a review is a random UUID v4, equal to the stored id; the sort key of the batch is stored', async () => {
      const items = await receivedOk(rw.world, backend());
      const stored = new Map((await reviewRows(rw.world, teamId)).map((r) => [r.id, r]));
      for (const item of items) {
        expectUuidV4(item.id);
        expect(stored.get(item.id)?.sort_key).toEqual(expect.any(Number));
      }
    });

    it('SEC-04 (5): an item has exactly the fields id, teamId, teamName, text, publishedOn - no author, no time of writing', async () => {
      const response = await receivedReviews(rw.world, backend(), { limit: 100 });
      const body = response.json<{ items: Record<string, unknown>[] }>();
      for (const item of body.items) expect(Object.keys(item).sort()).toEqual(BATCH_KEYS);
      expect(Object.keys(body).sort()).toEqual(['items', 'nextCursor']);
    });

    it('SEC-04: no answer of the API about reviews contains the author: not the id, the e-mail or the name', async () => {
      const answers = [
        (await receivedReviews(rw.world, backend())).body,
        (await receivedReviews(rw.world, frontend())).body,
        (await sentReviews(rw.world, lead(), teamId)).body,
        (await sentReviews(rw.world, frontend(), teamId)).body,
      ];
      const forBackend = answers[0] ?? '';
      for (const author of [lead(), frontend()]) {
        for (const secret of [author.id, author.email, author.displayName]) {
          expect(forBackend, `received list of B contains ${secret}`).not.toContain(secret);
        }
      }
      expect((await sentReviews(rw.world, lead(), teamId)).body).not.toContain(backend().email);
    });

    it('FR-PROF-08: a single notification "получены отзывы" is created for the subject at the publication, none for a withheld one', async () => {
      expect(await notificationCount(rw.world, backend().id)).toBe(notificationsBefore + 1);
      const feed = await rw.world.as(backend()).get('/v1/me/notifications');
      expect(feed.body).toMatch(/отзыв/i);
      expect(feed.body).not.toContain(lead().id);
    });

    it('SEC-04: the publication job run again (3 times at once) publishes nothing twice and notifies nobody again', async () => {
      const before = await notificationCount(rw.world, backend().id);
      const outcome = await closeWindow(rw.world, teamId, 3);
      expect(outcome.length).toBe(3);
      expect((await receivedOk(rw.world, backend())).length).toBe(2);
      expect(await notificationCount(rw.world, backend().id)).toBe(before);
    });

    it('SEC-04: the list is paged with a cursor without repeats; a limit above 100 -> 400 VALIDATION_FAILED', async () => {
      const first = await receivedReviews(rw.world, backend(), { limit: 1 });
      const page1 = expectOk<{ items: { id: string }[]; nextCursor: string | null }>(
        'listReceivedReviews',
        first,
        200,
      );
      expect(page1.items).toHaveLength(1);
      expect(page1.nextCursor).not.toBeNull();
      const second = await receivedReviews(rw.world, backend(), {
        limit: 1,
        cursor: page1.nextCursor ?? '',
      });
      const page2 = expectOk<{ items: { id: string }[]; nextCursor: string | null }>(
        'listReceivedReviews',
        second,
        200,
      );
      expect(page2.items).toHaveLength(1);
      expect(page2.items[0]?.id).not.toBe(page1.items[0]?.id);
      expect(page2.nextCursor).toBeNull();
      expectProblem(
        'listReceivedReviews',
        await receivedReviews(rw.world, backend(), { limit: 101 }),
        400,
        'VALIDATION_FAILED',
      );
    });

    it('SEC-04: the text is shown escaped: a review with markup does not come back as markup', async () => {
      const items = await receivedOk(rw.world, backend());
      const text = items.map((i) => i.text).join('\n');
      expect(text).toContain(`${MARKER}-fb`);
      expect(text).not.toMatch(/<script|<img/i);
    });
  });

  describe('the administrator and the purge (SEC-04, Р-20)', () => {
    it('SEC-04: the administrator reads only his own list: empty, whatever he passes; nobody else reaches the list of B', async () => {
      const own = await receivedOk(rw.world, rw.admin);
      expect(own).toEqual([]);
      const probe = await rw.world
        .as(rw.admin)
        .get(`/v1/me/reviews?subjectUserId=${backend().id}&userId=${backend().id}`);
      expect([200, 400]).toContain(probe.statusCode);
      expect(probe.body).not.toContain(`${MARKER}`);
    });

    it('SEC-04 (2): the withheld review stays until 30 days after the window, then the purge deletes it with its authorship', async () => {
      const total = (await reviewRows(rw.world, teamId)).length;
      await runReviewPurge(rw.world);
      expect(await reviewCountFor(rw.world, teamId, lead().id)).toBe(1);
      clockOf(rw.world).advance(31 * DAY);
      await runReviewPurge(rw.world);
      expect(await reviewCountFor(rw.world, teamId, lead().id)).toBe(0);
      const left = await reviewRows(rw.world, teamId);
      expect(left).toHaveLength(total - 1);
      expect(left.every((r) => r.status === 'published')).toBe(true);
      expect(await authorshipCount(rw.world, teamId)).toBe(left.length);
    });

    it('SEC-04: the published reviews survive the purge and are still listed', async () => {
      expect((await receivedOk(rw.world, backend())).length).toBe(2);
      expect((await sentOk(rw.world, lead(), teamId)).items.length).toBeGreaterThan(0);
    });
  });
});
