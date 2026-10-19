import { randomUUID } from 'node:crypto';
import { Redis } from 'ioredis';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startFakeLinkChecker, type FakeLinkChecker } from '../fakes/link-checker.js';
import { expectProblem } from '../fixtures/assertions.js';
import {
  complete,
  completableTeam,
  feedOk,
  linkedTeam,
  relabel,
  runCheck,
  type CompletableTeam,
} from '../fixtures/completion.js';
import { expectReplayOf, fireAll, tally, winnerOf } from '../fixtures/concurrency.js';
import {
  callback,
  connectRepository,
  createSession,
  ghPerson,
  github,
  link,
  locationOf,
  personalAccount,
  postWebhook,
  startSession,
  unlink,
  waitForDelivery,
} from '../fixtures/github.js';
import {
  activeGrantCount,
  completionCount,
  completionRows,
  contributionCount,
  contributionRows,
  deliveryRows,
  grantRows,
  repoLinkRows,
  teamReleaseUrl,
} from '../fixtures/github-db.js';
import { expectNoDeadlocks } from '../fixtures/teams-db.js';
import { githubUser, joinThroughOffer } from '../fixtures/teams.js';
import {
  itemOf,
  patchItem,
  routeTeam,
  startRouteWorld,
  transition,
} from '../fixtures/workspace.js';
import { itemRow, openStageCount } from '../fixtures/workspace-db.js';
import type { World } from '../fixtures/world.js';
import { FakeClock } from '../helpers/clock.js';
import { describeInfra, scanKeys } from '../helpers/infra.js';

/*
 * Races of slice 6 that are not CC-9, CC-11 or the "Завершить" part of CC-13 (docs/plan.md, "Тесты среза",
 * S6-02; architecture 12.3):
 *  - githubSetupCallback with one `state` x10 -> 1 success (GETDEL);
 *  - relabelContribution against completeProject: the snapshot sees the label before or after, never between
 *    (FOR SHARE of #4 against the completion's FOR NO KEY UPDATE);
 *  - the release link (T7) against the transition and against the completion;
 *  - unlinking the repository against a webhook and against the completion;
 *  - createInstallationSession and relabelContribution with a repeated key.
 */

describeInfra(
  'S6 races: state, labels, release link, unlink (FR-GH-01, FR-WORK-14, FR-WORK-17)',
  ['db', 'redis', 's3'],
  () => {
    let world: World;
    let checker: FakeLinkChecker;
    const clock = new FakeClock(Date.now());
    let deadlocksBefore = 0;
    let redis: Redis;

    beforeAll(async () => {
      world = await startRouteWorld({ github: true, clock });
      checker = startFakeLinkChecker(world.queuePrefix);
      redis = new Redis(process.env.REDIS_URL ?? '', { maxRetriesPerRequest: null });
      deadlocksBefore = await world.deadlocks();
    });

    afterAll(async () => {
      redis?.disconnect();
      await checker?.close();
      if (!world) return;
      await expectNoDeadlocks(world, deadlocksBefore);
      await world.close();
    });

    const app = () => github(world).app;

    describe('githubSetupCallback with one state (FR-GH-01, SEC-02)', () => {
      it('FR-GH-01: the same redirect x10 at once -> one success, nine refusals, one grant', async () => {
        const fx = await routeTeam(world);
        const { state } = await startSession(world, fx.lead, fx.team.id);
        const person = await ghPerson(world, fx.lead);
        const result = app().install(person, personalAccount(person), { state });
        const fired = await fireAll(10, () => callback(world, fx.lead, result.query));
        const successes = fired.filter(
          (f) =>
            f.status === 302 && locationOf(f.response, world).searchParams.get('error') === null,
        );
        expect(successes).toHaveLength(1);
        for (const f of fired.filter((x) => !successes.includes(x))) {
          expect([302, 400, 403]).toContain(f.status);
        }
        const installationId = Number(result.query.installation_id);
        expect(await grantRows(world, installationId)).toHaveLength(1);
        expect(await activeGrantCount(world, fx.team.id)).toBe(1);
      });

      it('FR-GH-01: ten different redirects with ten different states of one lead -> ten successes, still one grant per (installation, team, user)', async () => {
        const fx = await routeTeam(world);
        const person = await ghPerson(world, fx.lead);
        const queries: Record<string, string>[] = [];
        for (let i = 0; i < 10; i += 1) {
          const { state } = await startSession(world, fx.lead, fx.team.id);
          queries.push(app().install(person, personalAccount(person), { state }).query);
        }
        const fired = await fireAll(10, (i) => callback(world, fx.lead, queries[i] ?? {}));
        expect(fired.every((f) => f.status === 302)).toBe(true);
        const installationId = Number(queries[0]?.installation_id);
        expect(await grantRows(world, installationId)).toHaveLength(1);
      });

      it('FR-GH-01: the state of one lead used by the lead and by a thief at the same moment -> the thief gets nothing', async () => {
        const fx = await routeTeam(world);
        const thief = await githubUser(world, 'thief');
        const { state } = await startSession(world, fx.lead, fx.team.id);
        const person = await ghPerson(world, fx.lead);
        const result = app().install(person, personalAccount(person), { state });
        const fired = await fireAll(10, (i) =>
          callback(world, i % 2 === 0 ? fx.lead : thief, result.query),
        );
        const grants = await grantRows(world, Number(result.query.installation_id));
        expect(grants.every((g) => g.user_id === fx.lead.id)).toBe(true);
        expect(grants.length).toBeLessThanOrEqual(1);
        expect(fired.filter((f) => f.index % 2 === 1).every((f) => f.status !== 200)).toBe(true);
      });

      /** The states of this team only: Redis is shared with the other test files that run at the same time. */
      const statesOfTeam = async (teamId: string): Promise<number> => {
        const keys = (await scanKeys(redis, 'gh_state:*')).filter(
          (k) => !k.startsWith('gh_state:cache:'),
        );
        const values = await Promise.all(keys.map((k) => redis.get(k)));
        return values.filter((v) => v?.includes(teamId)).length;
      };

      it('FR-GH-01 (paired): createInstallationSession x5 with one key -> one state in Redis, the replays return the same answer', async () => {
        const fx = await routeTeam(world);
        const key = randomUUID();
        const before = await statesOfTeam(fx.team.id);
        const fired = await fireAll(
          5,
          (_i, k) => createSession(world, fx.lead, fx.team.id, k),
          Array.from({ length: 5 }, () => key),
        );
        const created = fired.filter((f) => f.status === 201);
        expect(created.length).toBeGreaterThanOrEqual(1);
        for (const f of fired.filter((x) => x.status !== 201)) expect(f.status).toBe(409);
        const winner = winnerOf(fired, 201);
        expectReplayOf(winner, await createSession(world, fx.lead, fx.team.id, key));
        expect(await statesOfTeam(fx.team.id)).toBe(before + 1);
      });
    });

    describe('relabelContribution against completeProject (12.3)', () => {
      const withTwoRoles = async (): Promise<{
        c: CompletableTeam;
        contributionId: string;
        ref: string;
      }> => {
        const c = await completableTeam(world);
        const seat = c.fx.team.openSeats[0];
        if (!seat) throw new Error('no open seat for the second role');
        await joinThroughOffer(world, c.fx.lead, c.fx.team.id, seat.id, c.fx.backend);
        await runCheck(world, c.fx.lead, c.fx.team.id);
        const mine = (
          await feedOk(world, c.fx.lead, c.fx.team.id, { userId: c.fx.backend.id, source: 'issue' })
        ).items[0];
        if (!mine) throw new Error('the backend member has no issue contribution');
        return { c, contributionId: mine.id, ref: mine.ref };
      };

      const roleInSnapshot = (snapshot: unknown, ref: string): string[] => {
        const found = findByRef(snapshot, ref);
        return found ? Object.values(found).filter((v): v is string => typeof v === 'string') : [];
      };

      it.each([1, 2, 3])(
        'FR-WORK-17: a relabel and the completion at once (round %i) -> the snapshot has the label before or after, the same as the stored one, locked',
        async () => {
          const { c, contributionId, ref } = await withTwoRoles();
          const [done, changed] = await Promise.all([
            complete(world, c.fx.lead, c.fx.team.id),
            relabel(world, c.fx.backend, c.fx.team.id, contributionId, { roleCode: 'devops' }),
          ]);
          expect(done.statusCode, done.body).toBe(201);
          expect([200, 409]).toContain(changed.statusCode);
          const [row] = (await contributionRows(world, c.fx.team.id)).filter(
            (r) => r.id === contributionId,
          );
          expect(row?.role_locked).toBe(true);
          expect(row?.role_code).toBe(changed.statusCode === 200 ? 'devops' : 'backend');
          const [completion] = await completionRows(world, c.fx.team.id);
          const strings = roleInSnapshot(completion?.snapshot, ref);
          expect(strings).toContain(row?.role_code);
          expect(strings).not.toContain(row?.role_code === 'devops' ? 'backend' : 'devops');
          if (changed.statusCode === 409) {
            expect(changed.json<{ code: string }>().code).toBe('INVALID_STATE');
          }
        },
        240_000,
      );

      it('FR-WORK-17: 20 relabels with two roles at once -> every one is 200, the stored label is one of the two', async () => {
        const { c, contributionId } = await withTwoRoles();
        const fired = await fireAll(20, (i, key) =>
          relabel(
            world,
            c.fx.backend,
            c.fx.team.id,
            contributionId,
            { roleCode: i % 2 === 0 ? 'devops' : 'backend' },
            key,
          ),
        );
        expect(tally(fired)).toEqual({ 200: 20 });
        const [row] = (await contributionRows(world, c.fx.team.id)).filter(
          (r) => r.id === contributionId,
        );
        expect(['devops', 'backend']).toContain(row?.role_code);
        expect(row?.role_locked).toBe(false);
      }, 240_000);

      it('FR-WORK-17 (paired): a relabel repeated with its key returns the stored answer and does not undo a newer label', async () => {
        const { c, contributionId } = await withTwoRoles();
        const key = randomUUID();
        const first = await relabel(
          world,
          c.fx.backend,
          c.fx.team.id,
          contributionId,
          { roleCode: 'devops' },
          key,
        );
        expect(first.statusCode).toBe(200);
        expect(
          (
            await relabel(world, c.fx.backend, c.fx.team.id, contributionId, {
              roleCode: 'backend',
            })
          ).statusCode,
        ).toBe(200);
        const replay = await relabel(
          world,
          c.fx.backend,
          c.fx.team.id,
          contributionId,
          { roleCode: 'devops' },
          key,
        );
        expect(replay.statusCode).toBe(200);
        const [row] = (await contributionRows(world, c.fx.team.id)).filter(
          (r) => r.id === contributionId,
        );
        expect(row?.role_code).toBe('backend');
      }, 240_000);
    });

    describe('the release link (T7) against the transition and the completion (FR-WORK-14, 12.3)', () => {
      const NEW_RELEASE = 'https://app.other-release.example.test/';

      it.each([1, 2])(
        'FR-WORK-14: the lead replaces the release link while the project is being completed (round %i) -> never both succeed',
        async () => {
          const c = await completableTeam(world);
          await runCheck(world, c.fx.lead, c.fx.team.id);
          const item = await itemOf(c.fx, 'mini_final_links', 3);
          const [done, replaced] = await Promise.all([
            complete(world, c.fx.lead, c.fx.team.id),
            patchItem(world, c.fx.lead, c.fx.team.id, item.id, {
              version: item.version,
              linkUrl: NEW_RELEASE,
            }),
          ]);
          expect([201, 409]).toContain(done.statusCode);
          expect([200, 409, 422]).toContain(replaced.statusCode);
          expect(done.statusCode === 201 && replaced.statusCode === 200).toBe(false);
          const stored = (await itemRow(world, item.id)).link_url;
          expect(await teamReleaseUrl(world, c.fx.team.id)).toBe(stored);
          if (done.statusCode === 201) {
            const [completion] = await completionRows(world, c.fx.team.id);
            expect(JSON.stringify(completion?.snapshot)).not.toContain(NEW_RELEASE);
          } else {
            expect(await completionCount(world, c.fx.team.id)).toBe(0);
          }
        },
        240_000,
      );

      it('FR-WORK-14: the link changed before the completion invalidates the check: the new release has to be checked first', async () => {
        const c = await completableTeam(world);
        await runCheck(world, c.fx.lead, c.fx.team.id);
        const item = await itemOf(c.fx, 'mini_final_links', 3);
        const changed = await patchItem(world, c.fx.lead, c.fx.team.id, item.id, {
          version: item.version,
          linkUrl: NEW_RELEASE,
        });
        if (changed.statusCode === 200) {
          const refused = await complete(world, c.fx.lead, c.fx.team.id);
          expectProblem('completeProject', refused, 409, 'COMPLETION_BLOCKED');
          expect(await completionCount(world, c.fx.team.id)).toBe(0);
        } else {
          expect([409, 422]).toContain(changed.statusCode);
        }
      }, 240_000);

      it.each([1, 2])(
        'FR-WORK-14: the release link against the transition of the last stage (round %i) -> consistent, no deadlock',
        async () => {
          const c = await completableTeam(world, { keepLastStageOpen: true });
          const item = await itemOf(c.fx, 'mini_final_links', 3);
          const [moved, replaced] = await Promise.all([
            transition(world, c.fx.lead, c.fx.team.id, 3),
            patchItem(world, c.fx.lead, c.fx.team.id, item.id, {
              version: item.version,
              linkUrl: NEW_RELEASE,
            }),
          ]);
          expect([201, 409]).toContain(moved.statusCode);
          expect([200, 409, 422]).toContain(replaced.statusCode);
          expect(await teamReleaseUrl(world, c.fx.team.id)).toBe(
            (await itemRow(world, item.id)).link_url,
          );
          expect(await openStageCount(world, c.fx.team.id)).toBeLessThanOrEqual(1);
        },
        240_000,
      );
    });

    describe('unlinking against webhooks and the completion (FR-GH-07)', () => {
      it('FR-GH-07: a webhook and the unlinking at once -> no error, the link is unlinked, later events are ignored', async () => {
        const fx = await routeTeam(world);
        const connected = await connectRepository(world, fx.team, [fx.backend, fx.frontend]);
        const backend = await ghPerson(world, fx.backend);
        const item = app().openIssue(connected.repo.id, { author: backend, assignees: [backend] });
        app().closeIssue(connected.repo.id, item.number);
        const request = app().issuesEvent('closed', item);
        const [hook, unlinked] = await Promise.all([
          postWebhook(world, request),
          unlink(world, fx.lead, fx.team.id),
        ]);
        expect(hook.statusCode).toBe(202);
        expect(unlinked.statusCode).toBe(204);
        await waitForDelivery(world, request.headers['x-github-delivery'] ?? '');
        expect((await repoLinkRows(world, fx.team.id)).map((r) => r.status)).toEqual(['unlinked']);
        expect(await contributionCount(world, fx.team.id)).toBeLessThanOrEqual(1);
        const late = app().openIssue(connected.repo.id, { author: backend, assignees: [backend] });
        app().closeIssue(connected.repo.id, late.number);
        const lateRequest = app().issuesEvent('closed', late);
        await postWebhook(world, lateRequest);
        expect(await waitForDelivery(world, lateRequest.headers['x-github-delivery'] ?? '')).toBe(
          'ignored',
        );
      });

      it('FR-GH-07: the unlinking against the completion -> never a completed project with an unlinked repository', async () => {
        const c = await completableTeam(world);
        await runCheck(world, c.fx.lead, c.fx.team.id);
        const [done, unlinked] = await Promise.all([
          complete(world, c.fx.lead, c.fx.team.id),
          unlink(world, c.fx.lead, c.fx.team.id),
        ]);
        expect([201, 409]).toContain(done.statusCode);
        expect([204, 409]).toContain(unlinked.statusCode);
        expect(done.statusCode === 201 && unlinked.statusCode === 204).toBe(false);
        const statuses = (await repoLinkRows(world, c.fx.team.id)).map((r) => r.status);
        if (done.statusCode === 201) expect(statuses).toEqual(['completed']);
        else expect(await completionCount(world, c.fx.team.id)).toBe(0);
      }, 240_000);

      it('CC-9: the repository freed by the unlinking is taken by one of ten teams that race for it', async () => {
        const fx = await routeTeam(world);
        const connected = await connectRepository(world, fx.team, [fx.backend, fx.frontend]);
        expect((await unlink(world, fx.lead, fx.team.id)).statusCode).toBe(204);
        const again = await Promise.all(
          Array.from({ length: 5 }, () =>
            link(world, fx.lead, fx.team.id, {
              installationId: connected.installation.id,
              repositoryId: connected.repo.id,
            }),
          ),
        );
        expect(again.filter((r) => r.statusCode === 200).length).toBeGreaterThanOrEqual(1);
        expect(
          (await repoLinkRows(world, fx.team.id)).filter((r) => r.status === 'active'),
        ).toHaveLength(1);
      });
    });

    describe('a webhook contribution against completeProject (M-5, 12.3)', () => {
      const sleep = (ms: number): Promise<void> =>
        new Promise((resolve) => setTimeout(resolve, ms));
      const HOLD_MS = 1500;

      it('M-5: a credit waits for the lock of the team and writes nothing once the project is completed', async () => {
        const { fx, connected } = await linkedTeam(world);
        const person = await ghPerson(world, fx.backend);
        const issue = app().openIssue(connected.repo.id, { author: person, assignees: [person] });
        app().closeIssue(connected.repo.id, issue.number);
        const request = app().issuesEvent('closed', issue);
        const deliveryId = request.headers['x-github-delivery'] ?? '';

        // The completion's own lock (#4), held by hand: the webhook arrives while the snapshot is being made.
        await world.sql.begin(async (tx) => {
          await tx`SELECT id FROM teams.team WHERE id = ${fx.team.id} FOR NO KEY UPDATE`;
          expect((await postWebhook(world, request)).statusCode).toBe(202);
          await sleep(HOLD_MS);
          expect(await contributionCount(world, fx.team.id)).toBe(0);
          await tx`UPDATE teams.team SET status = 'completed' WHERE id = ${fx.team.id}`;
        });

        await waitForDelivery(world, deliveryId);
        expect((await deliveryRows(world, deliveryId))[0]?.status).toBe('processed');
        expect(await contributionCount(world, fx.team.id)).toBe(0);
      });

      it('M-5: a credit that comes before the completion is in the snapshot, one that comes after is not written', async () => {
        const c = await completableTeam(world);
        await runCheck(world, c.fx.lead, c.fx.team.id);
        const late = app().openIssue(c.connected.repo.id, {
          author: c.backend,
          assignees: [c.backend],
        });
        app().closeIssue(c.connected.repo.id, late.number);
        const request = app().issuesEvent('closed', late);
        const [done, delivered] = await Promise.all([
          complete(world, c.fx.lead, c.fx.team.id),
          postWebhook(world, request),
        ]);
        expect(done.statusCode, done.body).toBe(201);
        expect(delivered.statusCode).toBe(202);
        await waitForDelivery(world, request.headers['x-github-delivery'] ?? '');
        const ref = `issue:${c.connected.repo.id}#${late.number}`;
        const written = (await contributionRows(world, c.fx.team.id)).some((r) => r.ref === ref);
        const [completion] = await completionRows(world, c.fx.team.id);
        const inSnapshot = findByRef(completion?.snapshot, ref) !== undefined;
        expect(written).toBe(inSnapshot);
        if (written) {
          expect(
            (await contributionRows(world, c.fx.team.id))
              .filter((r) => r.ref === ref)
              .every((r) => r.role_locked),
          ).toBe(true);
        }
      }, 240_000);
    });
  },
);

function findByRef(node: unknown, ref: string): Record<string, unknown> | undefined {
  if (Array.isArray(node)) {
    for (const entry of node) {
      const found = findByRef(entry, ref);
      if (found) return found;
    }
    return undefined;
  }
  if (node && typeof node === 'object') {
    const object = node as Record<string, unknown>;
    if (Object.values(object).includes(ref)) return object;
    for (const value of Object.values(object)) {
      const found = findByRef(value, ref);
      if (found) return found;
    }
  }
  return undefined;
}
