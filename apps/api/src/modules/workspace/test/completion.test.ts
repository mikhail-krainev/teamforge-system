import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startFakeLinkChecker, type FakeLinkChecker } from '../../../../test/fakes/link-checker.js';
import { expectProblem, expectReplayed } from '../../../../test/fixtures/assertions.js';
import {
  complete,
  completableTeam,
  completeOk,
  completionOf,
  feedOk,
  relabel,
  requestCheck,
  runCheck,
  type CompletableTeam,
  type CompletionDto,
} from '../../../../test/fixtures/completion.js';
import {
  closedIssueDelivered,
  github,
  issueRef,
  postWebhook,
  unlink,
  waitForDelivery,
} from '../../../../test/fixtures/github.js';
import {
  completionCount,
  completionRows,
  contributionRows,
  outboxCount,
  repoLinkRows,
} from '../../../../test/fixtures/github-db.js';
import { DAY, expectOk, githubUser } from '../../../../test/fixtures/teams.js';
import { routeTeam, startRouteWorld } from '../../../../test/fixtures/workspace.js';
import type { World } from '../../../../test/fixtures/world.js';
import { FakeClock } from '../../../../test/helpers/clock.js';
import { describeInfra, waitFor } from '../../../../test/helpers/infra.js';

/*
 * S6-02: completing a project (FR-WORK-13, FR-WORK-15, FR-WORK-12, FR-REW-11, FR-REW-15; architecture 11.4,
 * CC-13). completeProject with a team that meets every condition: the snapshot, the statuses, the locked
 * labels, the event, the days of delay; getCompletion; what is closed for a completed project. The refusals
 * (409 COMPLETION_BLOCKED with unmet[]) are in completion-blocks.test.ts, the races in test/concurrency.
 * Written before the implementation.
 */

describeInfra(
  'S6 workspace: completeProject, the snapshot and the page of results (FR-WORK-13, FR-WORK-15)',
  ['db', 'redis', 's3'],
  () => {
    let world: World;
    let checker: FakeLinkChecker;
    const clock = new FakeClock(Date.now());
    let c: CompletableTeam;
    let completion: CompletionDto;

    beforeAll(async () => {
      world = await startRouteWorld({ github: true, clock });
      checker = startFakeLinkChecker(world.queuePrefix);
      c = await completableTeam(world);
      completion = await completeOk(world, c);
    }, 240_000);

    afterAll(async () => {
      await checker?.close();
      if (!world) return;
      await world.close();
    });

    const teamId = (): string => c.fx.team.id;

    describe('the result (FR-WORK-13, FR-WORK-15)', () => {
      it('FR-WORK-13: 201 Completion: the time, the planned end, no delay, the credit is cooling down', () => {
        expect(completion.teamId).toBe(teamId());
        expect(Math.abs(Date.parse(completion.completedAt) - clock.now().getTime())).toBeLessThan(
          5 * 60_000,
        );
        expect(completion.overdueDays).toBe(0);
        expect(completion.onTime).toBe(true);
        expect(completion.credit.status).toBe('cooling');
        expect(Date.parse(completion.credit.coolingUntil)).toBeGreaterThan(
          Date.parse(completion.completedAt),
        );
      });

      it('FR-WORK-13 / CC-13: exactly one project_completion row; the team is completed; the repository is completed', async () => {
        expect(await completionCount(world, teamId())).toBe(1);
        const [team] = await world.sql<
          { status: string }[]
        >`SELECT status FROM teams.team WHERE id = ${teamId()}`;
        expect(team?.status).toBe('completed');
        expect((await repoLinkRows(world, teamId())).map((r) => r.status)).toEqual(['completed']);
      });

      it('FR-WORK-12: the planned end is the start plus the playbook days; the row agrees with the answer', async () => {
        const [row] = await completionRows(world, teamId());
        expect(row?.completed_by).toBe(c.fx.lead.id);
        expect(row?.overdue_days).toBe(0);
        expect(row?.planned_end_at.toISOString()).toBe(
          new Date(completion.plannedEndAt).toISOString(),
        );
        expect(row?.completed_at.toISOString()).toBe(
          new Date(completion.completedAt).toISOString(),
        );
      });

      it('FR-WORK-17: the roles of all contributions are fixed at completion (role_locked)', async () => {
        const rows = await contributionRows(world, teamId());
        expect(rows.length).toBeGreaterThanOrEqual(10);
        expect(rows.every((r) => r.role_locked)).toBe(true);
      });

      it('architecture 4: workspace.project_completed is published once, for the rewards and the profiles', async () => {
        await waitFor(async () => (await outboxCount(world, 'project_completed', teamId())) === 1);
        const [event] = await world.sql<
          { payload: { memberUserIds?: string[]; teamId?: string } }[]
        >`
          SELECT payload FROM platform.outbox_event WHERE type = 'project_completed' AND aggregate_id = ${teamId()}`;
        expect([...(event?.payload.memberUserIds ?? [])].sort()).toEqual(
          [c.fx.lead.id, c.fx.backend.id, c.fx.frontend.id].sort(),
        );
      });
    });

    describe('the snapshot (FR-WORK-13, FR-REW-15)', () => {
      const snapshotText = async (): Promise<string> => {
        const [row] = await completionRows(world, teamId());
        return JSON.stringify(row?.snapshot ?? {});
      };

      it('FR-WORK-13: the composition of the team at the moment: all three members with their roles', async () => {
        const text = await snapshotText();
        for (const id of [c.fx.lead.id, c.fx.backend.id, c.fx.frontend.id])
          expect(text).toContain(id);
        expect(text).toContain('backend');
        expect(text).toContain('frontend');
      });

      it('FR-REW-15: the seats with the `desired` flag and the deficit at the moment of joining are recorded', async () => {
        const text = await snapshotText();
        expect(text).toMatch(/desired/i);
        expect(text).toMatch(/deficit_?at_?join/i);
      });

      it('FR-WORK-16: the contributions with their roles are recorded: every ref of the project is in the snapshot', async () => {
        const text = await snapshotText();
        for (const ref of c.refs) expect(text).toContain(ref);
      });

      it('FR-WORK-13: the stages and the days of delay are recorded', async () => {
        const text = await snapshotText();
        for (const key of ['mini_s1', 'mini_s2', 'mini_s3']) expect(text).toContain(key);
        expect(text).toMatch(/overdue_?days/i);
      });

      it('FR-WORK-13: the snapshot is immutable: neither the owner nor the application may change the completed row', async () => {
        await expect(
          world.sql`UPDATE workspace.project_completion SET snapshot = '{}'::jsonb WHERE team_id = ${teamId()}`,
        ).rejects.toThrow();
        await expect(
          world.sql`UPDATE workspace.project_completion SET overdue_days = 99 WHERE team_id = ${teamId()}`,
        ).rejects.toThrow();
        const [row] = await completionRows(world, teamId());
        expect(JSON.stringify(row?.snapshot)).toContain('mini_s1');
        expect(row?.overdue_days).toBe(0);
      });
    });

    describe('getCompletion (FR-WORK-15)', () => {
      it('FR-WORK-15: every participant opens the page of results and sees the same data', async () => {
        const bodies: CompletionDto[] = [];
        for (const who of [c.fx.lead, c.fx.backend, c.fx.frontend]) {
          bodies.push(
            expectOk<CompletionDto>('getCompletion', await completionOf(world, who, teamId()), 200),
          );
        }
        expect(bodies[0]).toEqual(completion);
        expect(bodies[1]).toEqual(bodies[0]);
        expect(bodies[2]).toEqual(bodies[0]);
      });

      it('FR-WORK-15: a person outside the team gets 404 (no existence oracle)', async () => {
        const stranger = await githubUser(world, 'stranger');
        const foreign = await completionOf(world, stranger, teamId());
        expectProblem('getCompletion', foreign, 404, 'NOT_FOUND');
        const unknown = await world.as(stranger).get(`/v1/teams/${randomUUID()}/completion`);
        expect(foreign.statusCode).toBe(unknown.statusCode);
      });

      it('FR-WORK-15: a team that is not completed has no results: 404', async () => {
        const fresh = await routeTeam(world);
        expectProblem(
          'getCompletion',
          await completionOf(world, fresh.lead, fresh.team.id),
          404,
          'NOT_FOUND',
        );
      });

      it('FR-WORK-15: without a session -> 401', async () => {
        const response = await world.anonymous().get(`/v1/teams/${teamId()}/completion`);
        expectProblem('getCompletion', response, 401, 'UNAUTHENTICATED');
      });
    });

    describe('after the completion (FR-WORK-13, FR-GH-07, FR-WORK-17)', () => {
      it('CC-13: pressing "Завершить" again -> 409 INVALID_STATE; with the same key the stored 201 is replayed', async () => {
        const again = await complete(world, c.fx.lead, teamId());
        expectProblem('completeProject', again, 409, 'INVALID_STATE');
        expect(await completionCount(world, teamId())).toBe(1);
      });

      it('CC-13 (paired): the request that made the completion, repeated with its key, returns the stored 201', async () => {
        const key = randomUUID();
        const other = await completableTeam(world);
        await runCheck(world, other.fx.lead, other.fx.team.id);
        const first = await complete(world, other.fx.lead, other.fx.team.id, key);
        expect(first.statusCode, first.body).toBe(201);
        const replay = await complete(world, other.fx.lead, other.fx.team.id, key);
        expect(replay.statusCode).toBe(201);
        expectReplayed(replay);
        expect(replay.json()).toEqual(first.json());
        expect(await completionCount(world, other.fx.team.id)).toBe(1);
      }, 240_000);

      it('FR-WORK-13: a completed project cannot ask for another check (409 INVALID_STATE)', async () => {
        expectProblem(
          'requestCompletionCheck',
          await requestCheck(world, c.fx.lead, teamId()),
          409,
          'INVALID_STATE',
        );
      });

      it('FR-GH-07: a completed project cannot be unlinked from its repository (409 INVALID_STATE)', async () => {
        expectProblem(
          'unlinkRepository',
          await unlink(world, c.fx.lead, teamId()),
          409,
          'INVALID_STATE',
        );
      });

      it('FR-WORK-17: the role of a contribution cannot be changed any more (409 INVALID_STATE)', async () => {
        const entry = (await feedOk(world, c.fx.lead, teamId(), { limit: 1 })).items[0];
        if (!entry) throw new Error('the feed is empty');
        const owner =
          [c.fx.backend, c.fx.frontend].find((u) => u.id === entry.userId) ?? c.fx.backend;
        expectProblem(
          'relabelContribution',
          await relabel(world, owner, teamId(), entry.id, { roleCode: entry.roleCode }),
          409,
          'INVALID_STATE',
        );
      });

      it('FR-GH-07: new events of the finished repository add nothing to the project', async () => {
        const before = (await contributionRows(world, teamId())).length;
        const app = github(world).app;
        const item = app.openIssue(c.connected.repo.id, {
          author: c.backend,
          assignees: [c.backend],
        });
        app.closeIssue(c.connected.repo.id, item.number);
        const request = app.issuesEvent('closed', item);
        expect((await postWebhook(world, request)).statusCode).toBe(202);
        await waitForDelivery(world, request.headers['x-github-delivery'] ?? '');
        expect((await contributionRows(world, teamId())).length).toBe(before);
      });

      it('FR-WORK-16: the feed of a completed project is still readable', async () => {
        const page = await feedOk(world, c.fx.frontend, teamId(), { limit: 100 });
        expect(page.items.length).toBeGreaterThanOrEqual(10);
      });
    });

    describe('the delay (FR-WORK-12, FR-WORK-15)', () => {
      it('FR-WORK-12: a project finished after the planned end shows the days of delay (rounded up) and is not on time', async () => {
        const late = await completableTeam(world, { daysBeforeFinish: 40 });
        const body = await completeOk(world, late);
        const [row] = await completionRows(world, late.fx.team.id);
        const expected = Math.max(
          0,
          Math.ceil(
            ((row?.completed_at.getTime() ?? 0) - (row?.planned_end_at.getTime() ?? 0)) / DAY,
          ),
        );
        expect(expected).toBeGreaterThan(0);
        expect(body.overdueDays).toBe(expected);
        expect(body.onTime).toBe(false);
        expect(row?.overdue_days).toBe(expected);
        const read = expectOk<CompletionDto>(
          'getCompletion',
          await completionOf(world, late.fx.frontend, late.fx.team.id),
          200,
        );
        expect(read.overdueDays).toBe(expected);
      }, 240_000);

      it('FR-WORK-12: a delay does not block the completion (FR-WORK-13: "просрочка завершению не мешает")', async () => {
        const late = await completableTeam(world, { daysBeforeFinish: 60 });
        await runCheck(world, late.fx.lead, late.fx.team.id);
        const response = await complete(world, late.fx.lead, late.fx.team.id);
        expect(response.statusCode, response.body).toBe(201);
      }, 240_000);
    });

    it('FR-WORK-13: a contribution delivered just before the completion is in the snapshot of its team', async () => {
      const own = await completableTeam(world);
      const { item } = await closedIssueDelivered(world, own.connected.repo, {
        author: own.backend,
        assignees: [own.backend],
      });
      await runCheck(world, own.fx.lead, own.fx.team.id);
      expect((await complete(world, own.fx.lead, own.fx.team.id)).statusCode).toBe(201);
      const [row] = await completionRows(world, own.fx.team.id);
      expect(JSON.stringify(row?.snapshot)).toContain(issueRef(own.connected.repo, item.number));
    }, 240_000);
  },
);
