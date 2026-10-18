import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { expectProblem } from '../../../../test/fixtures/assertions.js';
import {
  feed,
  feedAll,
  feedOk,
  summary,
  linkedTeam,
  type ContributionSummaryDto,
  type FeedEntryDto,
} from '../../../../test/fixtures/completion.js';
import {
  closedIssueDelivered,
  deliverAndWait,
  ghPerson,
  github,
  mergedPullDelivered,
  waitForContributions,
} from '../../../../test/fixtures/github.js';
import { contributionCount, contributionRows } from '../../../../test/fixtures/github-db.js';
import { expectOk, githubUser } from '../../../../test/fixtures/teams.js';
import {
  doneRitual,
  doneWithFile,
  doneWithLink,
  itemOf,
  patchItem,
  routeTeam,
  startRouteWorld,
  type RouteFixture,
} from '../../../../test/fixtures/workspace.js';
import type { World } from '../../../../test/fixtures/world.js';
import { FakeClock } from '../../../../test/helpers/clock.js';
import { describeInfra, waitFor } from '../../../../test/helpers/infra.js';

/*
 * S6-02: the feed of the team and the summary of contributions (FR-WORK-16, FR-WORK-17, FR-GH-05, FR-GH-11):
 * getTeamFeed (cursor, filters by executor and source), getContributionSummary (by member and role),
 * contributions of artifacts and rituals (an item that becomes `done` creates one, an item that returns to
 * `open` makes it inactive). Written before the implementation.
 */

describeInfra(
  'S6 workspace: feed and contribution summary (FR-WORK-16, FR-WORK-17, FR-GH-11)',
  ['db', 'redis', 's3'],
  () => {
    let world: World;
    const clock = new FakeClock(Date.now());
    let fx: RouteFixture;
    let teamId: string;
    let backendId: string;
    let frontendId: string;

    beforeAll(async () => {
      world = await startRouteWorld({ github: true, clock });
      const built = await linkedTeam(world);
      fx = built.fx;
      teamId = fx.team.id;
      backendId = fx.backend.id;
      frontendId = fx.frontend.id;
      const backend = await ghPerson(world, fx.backend);
      const frontend = await ghPerson(world, fx.frontend);
      for (const title of ['Alpha', 'Beta', 'Gamma']) {
        clock.advance(60_000);
        await closedIssueDelivered(world, built.connected.repo, {
          author: backend,
          assignees: [backend],
          title,
        });
      }
      clock.advance(60_000);
      await closedIssueDelivered(world, built.connected.repo, {
        author: frontend,
        assignees: [frontend],
        title: 'Delta',
      });
      for (const title of ['Epsilon', 'Zeta']) {
        clock.advance(60_000);
        await mergedPullDelivered(world, built.connected.repo, { author: frontend, title });
      }
      clock.advance(60_000);
      await doneWithLink(fx, 'mini_board', fx.backend);
      clock.advance(60_000);
      await doneRitual(fx, 'mini_kickoff', fx.frontend);
      await waitForContributions(world, teamId, 8);
    });

    afterAll(async () => {
      if (!world) return;
      await world.close();
    });

    describe('getTeamFeed (FR-WORK-16)', () => {
      it('FR-WORK-16: any member sees the issues, pull requests, artifacts and rituals of the team, newest first', async () => {
        const page = await feedOk(world, fx.backend, teamId, { limit: 100 });
        expect(page.items).toHaveLength(8);
        expect(page.nextCursor).toBeNull();
        expect(new Set(page.items.map((e) => e.source))).toEqual(
          new Set(['issue', 'pr', 'artifact', 'ritual']),
        );
        const times = page.items.map((e) => Date.parse(e.receivedAt));
        expect(times).toEqual([...times].sort((x, y) => y - x));
        for (const entry of page.items) {
          expect(entry.id).toMatch(/^[0-9a-f-]{36}$/);
          expect([backendId, frontendId]).toContain(entry.userId);
          expect(entry.active).toBe(true);
          expect(entry.roleCode).toBe(entry.userId === backendId ? 'backend' : 'frontend');
        }
      });

      it('FR-WORK-16: every member (the lead too) reads the same feed', async () => {
        const [lead, backend, frontend] = await Promise.all([
          feedOk(world, fx.lead, teamId, { limit: 100 }),
          feedOk(world, fx.backend, teamId, { limit: 100 }),
          feedOk(world, fx.frontend, teamId, { limit: 100 }),
        ]);
        expect(lead).toEqual(backend);
        expect(backend).toEqual(frontend);
      });

      it('FR-WORK-16: an issue carries the title and the link of GitHub; an artifact and a ritual carry the title of the step', async () => {
        const page = await feedOk(world, fx.lead, teamId, { limit: 100 });
        const issue = page.items.find((e) => e.title === 'Alpha');
        expect(issue).toMatchObject({ source: 'issue', stageOrdinal: 1 });
        expect(issue?.url).toMatch(/^https?:\/\/.+\/issues\/\d+$/);
        const artifact = page.items.find((e) => e.source === 'artifact');
        const ritual = page.items.find((e) => e.source === 'ritual');
        expect(artifact?.ref).toMatch(/^item:[0-9a-f-]{36}$/);
        expect(artifact?.title).toBe('Репозиторий и доска');
        expect(ritual?.title).toBe('Kickoff команды');
        expect(ritual?.userId).toBe(frontendId);
      });

      it('FR-WORK-16: pages by cursor: 3 + 3 + 2, no repeats, no gaps, the last page has a null cursor', async () => {
        const first = await feedOk(world, fx.lead, teamId, { limit: 3 });
        expect(first.items).toHaveLength(3);
        expect(first.nextCursor).toBeTruthy();
        const second = await feedOk(world, fx.lead, teamId, {
          limit: 3,
          cursor: first.nextCursor ?? '',
        });
        expect(second.items).toHaveLength(3);
        const third = await feedOk(world, fx.lead, teamId, {
          limit: 3,
          cursor: second.nextCursor ?? '',
        });
        expect(third.items).toHaveLength(2);
        expect(third.nextCursor).toBeNull();
        const ids = [...first.items, ...second.items, ...third.items].map((e) => e.id);
        expect(new Set(ids).size).toBe(8);
        const whole = await feedAll(world, fx.lead, teamId, {}, 100);
        expect(ids).toEqual(whole.map((e) => e.id));
      });

      it('FR-WORK-16: a new entry between two page requests neither repeats nor hides entries of the pages not yet read', async () => {
        const own = await linkedTeam(world);
        const person = await ghPerson(world, own.fx.backend);
        const close = async (title: string) => {
          clock.advance(60_000);
          await closedIssueDelivered(world, own.connected.repo, {
            author: person,
            assignees: [person],
            title,
          });
        };
        for (const title of ['e1', 'e2', 'e3', 'e4', 'e5', 'e6']) await close(title);
        const first = await feedOk(world, own.fx.lead, own.fx.team.id, { limit: 3 });
        expect(first.items.map((e) => e.title)).toEqual(['e6', 'e5', 'e4']);
        await close('e7');
        const second = await feedOk(world, own.fx.lead, own.fx.team.id, {
          limit: 3,
          cursor: first.nextCursor ?? '',
        });
        expect(second.items.map((e) => e.title)).toEqual(['e3', 'e2', 'e1']);
        expect(
          (await feedOk(world, own.fx.lead, own.fx.team.id, { limit: 1 })).items[0]?.title,
        ).toBe('e7');
      });

      it('FR-WORK-16: filter by executor shows only his entries', async () => {
        const mine = await feedAll(world, fx.lead, teamId, { userId: backendId });
        expect(mine.length).toBe(4);
        expect(mine.every((e) => e.userId === backendId)).toBe(true);
        const theirs = await feedAll(world, fx.lead, teamId, { userId: frontendId });
        expect(theirs.length).toBe(4);
        expect(mine.length + theirs.length).toBe(8);
      });

      it.each([
        ['issue', 4],
        ['pr', 2],
        ['artifact', 1],
        ['ritual', 1],
      ] as const)('FR-WORK-16: filter by source %s -> %i', async (source, expected) => {
        const entries = await feedAll(world, fx.lead, teamId, { source });
        expect(entries).toHaveLength(expected);
        expect(entries.every((e: FeedEntryDto) => e.source === source)).toBe(true);
      });

      it('FR-WORK-16: the filters combine', async () => {
        const entries = await feedAll(world, fx.lead, teamId, { userId: frontendId, source: 'pr' });
        expect(entries).toHaveLength(2);
      });

      it('FR-WORK-16: a filter by a person who is not in the team is an empty page, not an error and not a leak', async () => {
        const other = await githubUser(world, 'not-in-team');
        const page = await feedOk(world, fx.lead, teamId, { userId: other.id });
        expect(page).toEqual({ items: [], nextCursor: null });
      });

      it.each([
        ['an unknown source', { source: 'commit' }],
        ['a user id that is not a UUID', { userId: 'not-a-uuid' }],
        ['limit 0', { limit: 0 }],
        ['limit 101', { limit: 101 }],
        ['a cursor that is not ours', { cursor: 'AAAA' }],
      ])('FR-WORK-16: %s -> 400', async (_title, query) => {
        const response = await feed(world, fx.lead, teamId, query);
        expect(response.statusCode, response.body).toBe(400);
      });

      it('SEC-03: a user outside the team and a member of another team get 404, the same as for an unknown team', async () => {
        const stranger = await githubUser(world, 'stranger');
        const foreign = await feed(world, stranger, teamId);
        expectProblem('getTeamFeed', foreign, 404, 'NOT_FOUND');
        const unknown = await world.as(stranger).get(`/v1/teams/${randomUUID()}/feed`);
        expect(unknown.statusCode).toBe(foreign.statusCode);
      });

      it('FR-WORK-16: a team without a repository still has a feed (artifacts and rituals); it is empty before any work', async () => {
        const fresh = await routeTeam(world);
        expect(await feedOk(world, fresh.lead, fresh.team.id)).toEqual({
          items: [],
          nextCursor: null,
        });
      });
    });

    describe('contributions of artifacts and rituals (FR-WORK-16, FR-WORK-17)', () => {
      it('FR-WORK-17: closing a step creates one contribution of the person who closed it, with the role he holds', async () => {
        const rows = await contributionRows(world, teamId);
        const artifact = rows.find((r) => r.source === 'artifact');
        const ritual = rows.find((r) => r.source === 'ritual');
        expect(artifact).toMatchObject({ user_id: backendId, role_code: 'backend', active: true });
        expect(ritual).toMatchObject({ user_id: frontendId, role_code: 'frontend', active: true });
        expect(artifact?.ref).toBe(`item:${(await itemOf(fx, 'mini_board')).id}`);
      });

      it('FR-WORK-17: a step whose owner role the person holds uses that role (spec: backend)', async () => {
        const own = await routeTeam(world);
        await doneWithFile(own, 'mini_spec', own.backend);
        await waitFor(
          async () => (await contributionCount(world, own.team.id, { source: 'artifact' })) === 1,
        );
        const [row] = await contributionRows(world, own.team.id);
        expect(row).toMatchObject({
          user_id: own.backend.id,
          role_code: 'backend',
          source: 'artifact',
        });
      });

      it('FR-WORK-17: an item that goes back to `open` makes its contribution inactive; done again -> active, still one row', async () => {
        const own = await routeTeam(world);
        await doneWithLink(own, 'mini_board', own.backend);
        await waitFor(
          async () => (await contributionCount(world, own.team.id, { active: true })) === 1,
        );
        const done = await itemOf(own, 'mini_board');
        expectOk(
          'updateChecklistItem',
          await patchItem(world, own.backend, own.team.id, done.id, {
            version: done.version,
            status: 'open',
          }),
          200,
        );
        await waitFor(
          async () => (await contributionCount(world, own.team.id, { active: false })) === 1,
        );
        const reopened = await itemOf(own, 'mini_board');
        expectOk(
          'updateChecklistItem',
          await patchItem(world, own.backend, own.team.id, reopened.id, {
            version: reopened.version,
            status: 'done',
          }),
          200,
        );
        await waitFor(
          async () => (await contributionCount(world, own.team.id, { active: true })) === 1,
        );
        expect(await contributionCount(world, own.team.id)).toBe(1);
      });
    });

    describe('getContributionSummary (FR-WORK-16)', () => {
      it('FR-WORK-16: the summary counts the issues, pull requests, artifacts and rituals of every member by role', async () => {
        const response = await summary(world, fx.backend, teamId);
        const body = expectOk<ContributionSummaryDto>('getContributionSummary', response, 200);
        const byUser = new Map(body.members.map((m) => [m.userId, m.byRole]));
        expect(byUser.get(backendId)).toEqual([
          { roleCode: 'backend', issues: 3, prs: 0, artifacts: 1, rituals: 0 },
        ]);
        expect(byUser.get(frontendId)).toEqual([
          { roleCode: 'frontend', issues: 1, prs: 2, artifacts: 0, rituals: 1 },
        ]);
        expect(Array.isArray(body.unassignedItemIds)).toBe(true);
      });

      it('FR-WORK-16: an inactive contribution (issue reopened) is not counted', async () => {
        const own = await linkedTeam(world);
        const person = await ghPerson(world, own.fx.backend);
        const { item } = await closedIssueDelivered(world, own.connected.repo, {
          author: person,
          assignees: [person],
        });
        const before = expectOk<ContributionSummaryDto>(
          'getContributionSummary',
          await summary(world, own.fx.lead, own.fx.team.id),
          200,
        );
        expect(before.members.find((m) => m.userId === own.fx.backend.id)?.byRole[0]?.issues).toBe(
          1,
        );
        const app = github(world).app;
        app.reopenIssue(own.connected.repo.id, item.number);
        await deliverAndWait(world, app.issuesEvent('reopened', item));
        await waitFor(
          async () => (await contributionCount(world, own.fx.team.id, { active: false })) === 1,
        );
        const after = expectOk<ContributionSummaryDto>(
          'getContributionSummary',
          await summary(world, own.fx.lead, own.fx.team.id),
          200,
        );
        expect(
          after.members.find((m) => m.userId === own.fx.backend.id)?.byRole[0]?.issues ?? 0,
        ).toBe(0);
      });

      it('FR-WORK-16: the summary of a team without work has every member with no roles or zeros', async () => {
        const fresh = await routeTeam(world);
        const body = expectOk<ContributionSummaryDto>(
          'getContributionSummary',
          await summary(world, fresh.lead, fresh.team.id),
          200,
        );
        for (const member of body.members) {
          for (const role of member.byRole) {
            expect(role.issues + role.prs + role.artifacts + role.rituals).toBe(0);
          }
        }
      });

      it('SEC-03: an outsider gets 404', async () => {
        const stranger = await githubUser(world, 'stranger');
        expectProblem(
          'getContributionSummary',
          await summary(world, stranger, teamId),
          404,
          'NOT_FOUND',
        );
      });
    });
  },
);
