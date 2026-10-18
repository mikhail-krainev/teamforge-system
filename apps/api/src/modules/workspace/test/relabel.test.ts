import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { expectProblem, expectReplayed } from '../../../../test/fixtures/assertions.js';
import {
  feedOk,
  linkedTeam,
  relabel,
  summary,
  type ContributionSummaryDto,
  type FeedEntryDto,
} from '../../../../test/fixtures/completion.js';
import {
  closedIssueDelivered,
  ghPerson,
  mergedPullDelivered,
} from '../../../../test/fixtures/github.js';
import { contributionRows } from '../../../../test/fixtures/github-db.js';
import { expectOk, githubUser, joinThroughOffer } from '../../../../test/fixtures/teams.js';
import {
  doneWithLink,
  itemOf,
  startRouteWorld,
  type RouteFixture,
} from '../../../../test/fixtures/workspace.js';
import type { World } from '../../../../test/fixtures/world.js';
import { FakeClock } from '../../../../test/helpers/clock.js';
import { describeInfra, waitFor } from '../../../../test/helpers/infra.js';

/*
 * S6-02: the role of a contribution (FR-WORK-17, FR-REW-02): relabelContribution. A member who holds two
 * roles changes the role of his own contribution to the other one; a role he does not hold is 422, a
 * contribution of somebody else or of another team is 404, a finished project is 409 INVALID_STATE, a team
 * that is voting or suspended is 409 TEAM_STATUS_BLOCKS_ACTION. Written before the implementation.
 */

describeInfra(
  'S6 workspace: relabel the role of a contribution (FR-WORK-17)',
  ['db', 'redis', 's3'],
  () => {
    let world: World;
    const clock = new FakeClock(Date.now());

    beforeAll(async () => {
      world = await startRouteWorld({ github: true, clock });
    });

    afterAll(async () => {
      if (!world) return;
      await world.close();
    });

    interface Scenario {
      fx: RouteFixture;
      /** The backend member also holds `devops` (a second seat), so he has two roles to choose from. */
      mine: FeedEntryDto;
      theirs: FeedEntryDto;
      pr: FeedEntryDto;
    }

    const scenario = async (): Promise<Scenario> => {
      const built = await linkedTeam(world);
      const { fx, connected } = built;
      const seat = fx.team.openSeats[0];
      if (!seat) throw new Error('the fixture team has no open seat for the second role');
      await joinThroughOffer(world, fx.lead, fx.team.id, seat.id, fx.backend);
      const backend = await ghPerson(world, fx.backend);
      const frontend = await ghPerson(world, fx.frontend);
      await closedIssueDelivered(world, connected.repo, {
        author: backend,
        assignees: [backend],
        title: 'Моя задача',
      });
      await closedIssueDelivered(world, connected.repo, {
        author: frontend,
        assignees: [frontend],
        title: 'Чужая задача',
      });
      await mergedPullDelivered(world, connected.repo, { author: backend, title: 'Мой PR' });
      const page = await feedOk(world, fx.lead, fx.team.id, { limit: 100 });
      const find = (title: string): FeedEntryDto => {
        const found = page.items.find((e) => e.title === title);
        if (!found) throw new Error(`no feed entry "${title}"`);
        return found;
      };
      return { fx, mine: find('Моя задача'), theirs: find('Чужая задача'), pr: find('Мой PR') };
    };

    it('FR-WORK-17: the owner changes the role of his contribution to another role he holds -> 200 FeedEntry with the new role', async () => {
      const s = await scenario();
      expect(s.mine.roleCode).toBe('backend');
      const response = await relabel(world, s.fx.backend, s.fx.team.id, s.mine.id, {
        roleCode: 'devops',
      });
      const body = expectOk<FeedEntryDto>('relabelContribution', response, 200);
      expect(body).toMatchObject({
        id: s.mine.id,
        roleCode: 'devops',
        userId: s.fx.backend.id,
        active: true,
      });
      const after = (await feedOk(world, s.fx.lead, s.fx.team.id, { limit: 100 })).items.find(
        (e) => e.id === s.mine.id,
      );
      expect(after?.roleCode).toBe('devops');
      const [row] = (await contributionRows(world, s.fx.team.id)).filter((r) => r.id === s.mine.id);
      expect(row).toMatchObject({ role_code: 'devops', role_locked: false });
    });

    it('FR-WORK-17: he may change it back; the summary follows the label', async () => {
      const s = await scenario();
      expectOk(
        'relabelContribution',
        await relabel(world, s.fx.backend, s.fx.team.id, s.mine.id, { roleCode: 'devops' }),
        200,
      );
      const moved = expectOk<ContributionSummaryDto>(
        'getContributionSummary',
        await summary(world, s.fx.lead, s.fx.team.id),
        200,
      );
      const roles = new Map(
        moved.members.find((m) => m.userId === s.fx.backend.id)?.byRole.map((r) => [r.roleCode, r]),
      );
      expect(roles.get('devops')).toMatchObject({ issues: 1, prs: 0 });
      expect(roles.get('backend')).toMatchObject({ issues: 0, prs: 1 });
      expectOk(
        'relabelContribution',
        await relabel(world, s.fx.backend, s.fx.team.id, s.mine.id, { roleCode: 'backend' }),
        200,
      );
      const back = expectOk<ContributionSummaryDto>(
        'getContributionSummary',
        await summary(world, s.fx.lead, s.fx.team.id),
        200,
      );
      const again = new Map(
        back.members.find((m) => m.userId === s.fx.backend.id)?.byRole.map((r) => [r.roleCode, r]),
      );
      expect(again.get('backend')).toMatchObject({ issues: 1, prs: 1 });
    });

    it('FR-WORK-17: relabelling to the role the contribution already has is a plain 200', async () => {
      const s = await scenario();
      const body = expectOk<FeedEntryDto>(
        'relabelContribution',
        await relabel(world, s.fx.backend, s.fx.team.id, s.mine.id, { roleCode: 'backend' }),
        200,
      );
      expect(body.roleCode).toBe('backend');
    });

    it('FR-WORK-17: a pull request is relabelled in the same way as an issue', async () => {
      const s = await scenario();
      const body = expectOk<FeedEntryDto>(
        'relabelContribution',
        await relabel(world, s.fx.backend, s.fx.team.id, s.pr.id, { roleCode: 'devops' }),
        200,
      );
      expect(body).toMatchObject({ source: 'pr', roleCode: 'devops' });
    });

    it('FR-WORK-17: a role the member does not hold in the team -> 422, the label stays', async () => {
      const s = await scenario();
      const response = await relabel(world, s.fx.backend, s.fx.team.id, s.mine.id, {
        roleCode: 'frontend',
      });
      expect(response.statusCode, response.body).toBe(422);
      expect(response.headers['content-type']).toContain('application/problem+json');
      const [row] = (await contributionRows(world, s.fx.team.id)).filter((r) => r.id === s.mine.id);
      expect(row?.role_code).toBe('backend');
    });

    it('FR-WORK-17: the contribution of another member is not found (404): nobody relabels it for him, the lead included', async () => {
      const s = await scenario();
      for (const who of [s.fx.backend, s.fx.lead]) {
        expectProblem(
          'relabelContribution',
          await relabel(world, who, s.fx.team.id, s.theirs.id, { roleCode: 'devops' }),
          404,
          'NOT_FOUND',
        );
      }
      const [row] = (await contributionRows(world, s.fx.team.id)).filter(
        (r) => r.id === s.theirs.id,
      );
      expect(row?.role_code).toBe('frontend');
    });

    it('SEC-03: the contribution of another team is not found; a random id is not found; an outsider gets 404', async () => {
      const s = await scenario();
      const other = await scenario();
      const stranger = await githubUser(world, 'stranger');
      expectProblem(
        'relabelContribution',
        await relabel(world, s.fx.backend, s.fx.team.id, other.mine.id, { roleCode: 'devops' }),
        404,
        'NOT_FOUND',
      );
      expectProblem(
        'relabelContribution',
        await relabel(world, s.fx.backend, other.fx.team.id, other.mine.id, { roleCode: 'devops' }),
        404,
        'NOT_FOUND',
      );
      expectProblem(
        'relabelContribution',
        await relabel(world, s.fx.backend, s.fx.team.id, randomUUID(), { roleCode: 'devops' }),
        404,
        'NOT_FOUND',
      );
      expectProblem(
        'relabelContribution',
        await relabel(world, stranger, s.fx.team.id, s.mine.id, { roleCode: 'devops' }),
        404,
        'NOT_FOUND',
      );
      const [row] = (await contributionRows(world, other.fx.team.id)).filter(
        (r) => r.id === other.mine.id,
      );
      expect(row?.role_code).toBe('backend');
    });

    it.each([
      ['no role', {}],
      ['a role that is not a code', { roleCode: 'Not A Role!' }],
      ['an extra field', { roleCode: 'backend', userId: randomUUID() }],
      ['a number', { roleCode: 7 }],
    ])('FR-WORK-17: %s -> 400', async (_title, body) => {
      const s = await scenario();
      const response = await relabel(world, s.fx.backend, s.fx.team.id, s.mine.id, body);
      expect(response.statusCode, response.body).toBe(400);
    });

    it('FR-WORK-17: without a session -> 401', async () => {
      const s = await scenario();
      const response = await world
        .anonymous()
        .patch(`/v1/teams/${s.fx.team.id}/contributions/${s.mine.id}`, { roleCode: 'backend' });
      expectProblem('relabelContribution', response, 401, 'UNAUTHENTICATED');
    });

    it('FR-WORK-17: a repeat with the same Idempotency-Key returns the stored answer', async () => {
      const s = await scenario();
      const key = randomUUID();
      const first = await relabel(
        world,
        s.fx.backend,
        s.fx.team.id,
        s.mine.id,
        { roleCode: 'devops' },
        key,
      );
      const replay = await relabel(
        world,
        s.fx.backend,
        s.fx.team.id,
        s.mine.id,
        { roleCode: 'devops' },
        key,
      );
      expect(first.statusCode).toBe(200);
      expectReplayed(replay);
      expect(replay.json()).toEqual(first.json());
    });

    it('FR-WORK-17: a project that is completed cannot be relabelled -> 409 INVALID_STATE (the labels are fixed)', async () => {
      const s = await scenario();
      await world.sql`UPDATE teams.team SET status = 'completed' WHERE id = ${s.fx.team.id}`;
      expectProblem(
        'relabelContribution',
        await relabel(world, s.fx.backend, s.fx.team.id, s.mine.id, { roleCode: 'devops' }),
        409,
        'INVALID_STATE',
      );
      const [row] = (await contributionRows(world, s.fx.team.id)).filter((r) => r.id === s.mine.id);
      expect(row?.role_code).toBe('backend');
    });

    it.each(['suspended', 'voting'] as const)(
      'FR-WORK-17: a %s team blocks the change: 409 TEAM_STATUS_BLOCKS_ACTION',
      async (status) => {
        const s = await scenario();
        await world.sql`UPDATE teams.team SET status = ${status} WHERE id = ${s.fx.team.id}`;
        expectProblem(
          'relabelContribution',
          await relabel(world, s.fx.backend, s.fx.team.id, s.mine.id, { roleCode: 'devops' }),
          409,
          'TEAM_STATUS_BLOCKS_ACTION',
        );
      },
    );

    it('FR-WORK-17: an artifact of the member is relabelled too (the label belongs to every kind of contribution)', async () => {
      const s = await scenario();
      await doneWithLink(s.fx, 'mini_board', s.fx.backend);
      const item = await itemOf(s.fx, 'mini_board');
      const entry = await waitFor(async () =>
        (await feedOk(world, s.fx.lead, s.fx.team.id, { source: 'artifact' })).items.find(
          (e) => e.ref === `item:${item.id}`,
        ),
      );
      const body = expectOk<FeedEntryDto>(
        'relabelContribution',
        await relabel(world, s.fx.backend, s.fx.team.id, entry.id, { roleCode: 'devops' }),
        200,
      );
      expect(body).toMatchObject({ source: 'artifact', roleCode: 'devops' });
    });
  },
);
