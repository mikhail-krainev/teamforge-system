import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, expect, it } from 'vitest';
import {
  OK_OUTCOME,
  startFakeLinkChecker,
  type FakeLinkChecker,
} from '../../../../test/fakes/link-checker.js';
import { expectProblem } from '../../../../test/fixtures/assertions.js';
import {
  complete,
  completableTeam,
  RELEASE_URL,
  runCheck,
  unmetCodes,
  type CompletableTeam,
} from '../../../../test/fixtures/completion.js';
import { github } from '../../../../test/fixtures/github.js';
import { completionCount, contributionRows } from '../../../../test/fixtures/github-db.js';
import { githubUser } from '../../../../test/fixtures/teams.js';
import { routeTeam, startRouteWorld } from '../../../../test/fixtures/workspace.js';
import { stageRows } from '../../../../test/fixtures/workspace-db.js';
import type { World } from '../../../../test/fixtures/world.js';
import { FakeClock } from '../../../../test/helpers/clock.js';
import { describeInfra } from '../../../../test/helpers/infra.js';

/*
 * S6-02: the refusals of completeProject (FR-WORK-13 (1)-(7), FR-GH-08, AF-01, AF-02, AF-04, AF-09, AF-10;
 * architecture 11.4): 409 COMPLETION_BLOCKED with the list `unmet[]` whose codes are the enumeration
 * UnmetCode of the contract. One team that meets every condition is built once; each test breaks exactly one
 * condition (in the database or on the GitHub double), expects exactly its code and puts everything back.
 * The first test relies on the order of the file: no check has been requested yet.
 */

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const FAILING_RELEASE = { ok: false, reason: 'TOO_SMALL', httpStatus: 200 } as const;
const BROKEN_LINK = { ok: false, reason: 'HTTP_STATUS', httpStatus: 404 } as const;

describeInfra(
  'S6 workspace: completeProject is refused with unmet[] (FR-WORK-13, FR-GH-08, AF-01..AF-10)',
  ['db', 'redis', 's3'],
  () => {
    let world: World;
    let checker: FakeLinkChecker;
    const clock = new FakeClock(Date.now());
    let c: CompletableTeam;

    beforeAll(async () => {
      world = await startRouteWorld({ github: true, clock });
      checker = startFakeLinkChecker(world.queuePrefix);
      c = await completableTeam(world);
    }, 240_000);

    afterAll(async () => {
      await checker?.close();
      if (!world) return;
      await world.close();
    });

    const teamId = (): string => c.fx.team.id;
    const lead = () => c.fx.lead;
    const app = () => github(world).app;

    const attempt = () => complete(world, lead(), teamId());

    /** Runs a fresh check (valid for an hour), then asks to complete. */
    const afterCheck = async () => {
      await runCheck(world, lead(), teamId());
      return attempt();
    };

    const expectBlocked = (
      response: Awaited<ReturnType<typeof attempt>>,
      codes: string[],
    ): void => {
      expectProblem('completeProject', response, 409, 'COMPLETION_BLOCKED');
      expect(unmetCodes(response)).toEqual([...codes].sort());
      for (const item of response.json<{ unmet: { message: string }[] }>().unmet) {
        expect(item.message.length).toBeGreaterThan(0);
      }
    };

    const expectStillOpen = async (): Promise<void> => {
      expect(await completionCount(world, teamId())).toBe(0);
      const [team] = await world.sql<
        { status: string }[]
      >`SELECT status FROM teams.team WHERE id = ${teamId()}`;
      expect(team?.status).toBe('active');
    };

    it('FR-WORK-13: without a check nothing can be completed: COMPLETION_CHECK_MISSING', async () => {
      expectBlocked(await attempt(), ['COMPLETION_CHECK_MISSING']);
      await expectStillOpen();
    });

    it('FR-WORK-13: a check older than an hour is not enough: COMPLETION_CHECK_EXPIRED', async () => {
      await runCheck(world, lead(), teamId());
      clock.advance(HOUR + 60_000);
      expectBlocked(await attempt(), ['COMPLETION_CHECK_EXPIRED']);
      await expectStillOpen();
    });

    it('FR-WORK-13 (1): a stage that is not closed: STAGES_NOT_CLOSED', async () => {
      await runCheck(world, lead(), teamId());
      const [, , third] = await stageRows(world, teamId());
      await world.sql`UPDATE workspace.project_stage SET status = 'open', closed_at = NULL WHERE id = ${third?.id ?? ''}`;
      try {
        expectBlocked(await attempt(), ['STAGES_NOT_CLOSED']);
      } finally {
        await world.sql`UPDATE workspace.project_stage SET status = 'closed', closed_at = ${third?.closed_at ?? null} WHERE id = ${third?.id ?? ''}`;
      }
      await expectStillOpen();
    });

    it('FR-WORK-13 (4): fewer than three members: MEMBERS_BELOW_MIN', async () => {
      await runCheck(world, lead(), teamId());
      await world.sql`UPDATE teams.membership SET status = 'left' WHERE team_id = ${teamId()} AND user_id = ${c.fx.backend.id}`;
      await world.sql`UPDATE teams.team SET member_count = member_count - 1 WHERE id = ${teamId()}`;
      try {
        expectBlocked(await attempt(), ['MEMBERS_BELOW_MIN']);
      } finally {
        await world.sql`UPDATE teams.membership SET status = 'active' WHERE team_id = ${teamId()} AND user_id = ${c.fx.backend.id}`;
        await world.sql`UPDATE teams.team SET member_count = member_count + 1 WHERE id = ${teamId()}`;
      }
      await expectStillOpen();
    });

    it('FR-WORK-13 (5) / AF-09: less than 14 days since the first stage opened: DURATION_TOO_SHORT', async () => {
      await runCheck(world, lead(), teamId());
      const [first] = await stageRows(world, teamId());
      const shift = clock.now().getTime() - 5 * DAY - (first?.opened_at?.getTime() ?? 0);
      const moved = (value: Date | null): Date | null =>
        value ? new Date(value.getTime() + shift) : null;
      await world.sql`UPDATE workspace.project_stage SET opened_at = ${moved(first?.opened_at ?? null)}, closed_at = ${moved(first?.closed_at ?? null)} WHERE id = ${first?.id ?? ''}`;
      try {
        expectBlocked(await attempt(), ['DURATION_TOO_SHORT']);
      } finally {
        await world.sql`UPDATE workspace.project_stage SET opened_at = ${first?.opened_at ?? null}, closed_at = ${first?.closed_at ?? null} WHERE id = ${first?.id ?? ''}`;
      }
      await expectStillOpen();
    });

    it('FR-WORK-13 (5) / AF-09: contributions on fewer than three calendar days: CONTRIBUTION_DAYS_TOO_FEW', async () => {
      await runCheck(world, lead(), teamId());
      const saved = await contributionRows(world, teamId());
      const sameDay = clock.now();
      await world.sql`UPDATE workspace.contribution SET received_at = ${sameDay}, occurred_at = ${sameDay} WHERE team_id = ${teamId()}`;
      try {
        expectBlocked(await attempt(), ['CONTRIBUTION_DAYS_TOO_FEW']);
      } finally {
        for (const row of saved) {
          await world.sql`UPDATE workspace.contribution SET received_at = ${row.received_at}, occurred_at = ${row.occurred_at} WHERE id = ${row.id}`;
        }
      }
      await expectStillOpen();
    });

    it('FR-WORK-13 (6) / AF-04: fewer than 10 merged pull requests and closed issues: CONTRIBUTION_TOO_LOW', async () => {
      await runCheck(world, lead(), teamId());
      const rows = (await contributionRows(world, teamId())).filter((r) => r.source === 'issue');
      const dropped = rows.slice(0, 2).map((r) => r.id);
      await world.sql`UPDATE workspace.contribution SET active = false WHERE id IN ${world.sql(dropped)}`;
      try {
        expectBlocked(await attempt(), ['CONTRIBUTION_TOO_LOW']);
      } finally {
        await world.sql`UPDATE workspace.contribution SET active = true WHERE id IN ${world.sql(dropped)}`;
      }
      await expectStillOpen();
    });

    it('FR-WORK-13 (6) / AF-04: contributions of a single account: CONTRIBUTORS_TOO_FEW', async () => {
      await runCheck(world, lead(), teamId());
      const saved = await contributionRows(world, teamId());
      await world.sql`UPDATE workspace.contribution SET user_id = ${c.fx.backend.id} WHERE team_id = ${teamId()}`;
      try {
        const response = await attempt();
        expectBlocked(response, ['CONTRIBUTORS_TOO_FEW']);
      } finally {
        for (const row of saved) {
          await world.sql`UPDATE workspace.contribution SET user_id = ${row.user_id} WHERE id = ${row.id}`;
        }
      }
      await expectStillOpen();
    });

    it('AF-10: a stage closed within 24 hours of its opening: STAGE_CLOSED_TOO_FAST', async () => {
      await runCheck(world, lead(), teamId());
      const [, second] = await stageRows(world, teamId());
      const fast = new Date((second?.opened_at?.getTime() ?? 0) + HOUR);
      await world.sql`UPDATE workspace.project_stage SET closed_at = ${fast} WHERE id = ${second?.id ?? ''}`;
      try {
        expectBlocked(await attempt(), ['STAGE_CLOSED_TOO_FAST']);
      } finally {
        await world.sql`UPDATE workspace.project_stage SET closed_at = ${second?.closed_at ?? null} WHERE id = ${second?.id ?? ''}`;
      }
      await expectStillOpen();
    });

    it('FR-GH-08 / AF-01: the repository does not pass the final check: REPO_FINAL_FAILED', async () => {
      const repo = app().repo(c.connected.repo.id);
      repo.archived = true;
      try {
        expectBlocked(await afterCheck(), ['REPO_FINAL_FAILED']);
      } finally {
        repo.archived = false;
      }
      await expectStillOpen();
    });

    it('FR-WORK-14 / AF-02: the release does not answer: RELEASE_CHECK_FAILED', async () => {
      checker.respondWith((url) => (url === RELEASE_URL ? FAILING_RELEASE : OK_OUTCOME));
      try {
        expectBlocked(await afterCheck(), ['RELEASE_CHECK_FAILED']);
      } finally {
        checker.respondWith(() => OK_OUTCOME);
      }
      await expectStillOpen();
    });

    it('FR-PLAY-08: a link of the project that broke: LINK_CHECK_FAILED', async () => {
      checker.respondWith((url) => (url.includes('example.test/board') ? BROKEN_LINK : OK_OUTCOME));
      try {
        expectBlocked(await afterCheck(), ['LINK_CHECK_FAILED']);
      } finally {
        checker.respondWith(() => OK_OUTCOME);
      }
      await expectStillOpen();
    });

    it('AF-02: the release address of an already completed project: the completion is blocked (FRAUD_BLOCK or RELEASE_CHECK_FAILED)', async () => {
      const earlier = await routeTeam(world);
      await world.sql`UPDATE teams.team SET status = 'completed', release_url = ${RELEASE_URL} WHERE id = ${earlier.team.id}`;
      await world.sql`
        INSERT INTO workspace.project_completion (team_id, completed_at, planned_end_at, overdue_days, snapshot, completed_by)
        VALUES (${earlier.team.id}, now(), now(), 0, '{}'::jsonb, ${earlier.lead.id})`;
      await runCheck(world, lead(), teamId());
      try {
        const response = await attempt();
        expectProblem('completeProject', response, 409, 'COMPLETION_BLOCKED');
        const codes = unmetCodes(response);
        expect(codes.some((code) => ['FRAUD_BLOCK', 'RELEASE_CHECK_FAILED'].includes(code))).toBe(
          true,
        );
      } finally {
        await world.sql`DELETE FROM workspace.project_completion WHERE team_id = ${earlier.team.id}`;
        await world.sql`UPDATE teams.team SET release_url = NULL WHERE id = ${earlier.team.id}`;
      }
      await expectStillOpen();
    });

    it('FR-WORK-13: several conditions at once are all listed, not only the first', async () => {
      await runCheck(world, lead(), teamId());
      const [, second] = await stageRows(world, teamId());
      const saved = await contributionRows(world, teamId());
      await world.sql`UPDATE workspace.project_stage SET closed_at = ${new Date((second?.opened_at?.getTime() ?? 0) + HOUR)} WHERE id = ${second?.id ?? ''}`;
      await world.sql`UPDATE workspace.contribution SET user_id = ${c.fx.backend.id} WHERE team_id = ${teamId()}`;
      try {
        expectBlocked(await attempt(), ['CONTRIBUTORS_TOO_FEW', 'STAGE_CLOSED_TOO_FAST']);
      } finally {
        await world.sql`UPDATE workspace.project_stage SET closed_at = ${second?.closed_at ?? null} WHERE id = ${second?.id ?? ''}`;
        for (const row of saved) {
          await world.sql`UPDATE workspace.contribution SET user_id = ${row.user_id} WHERE id = ${row.id}`;
        }
      }
      await expectStillOpen();
    });

    it.each(['voting', 'suspended'] as const)(
      'FR-WORK-13 (7): a %s team: 409 TEAM_STATUS_BLOCKS_ACTION (not a list of unmet conditions)',
      async (status) => {
        await runCheck(world, lead(), teamId());
        await world.sql`UPDATE teams.team SET status = ${status} WHERE id = ${teamId()}`;
        try {
          expectProblem('completeProject', await attempt(), 409, 'TEAM_STATUS_BLOCKS_ACTION');
        } finally {
          await world.sql`UPDATE teams.team SET status = 'active' WHERE id = ${teamId()}`;
        }
        await expectStillOpen();
      },
    );

    it('FR-WORK-13: only the lead completes: a member gets 403 NOT_TEAM_LEAD, an outsider 404, no session 401', async () => {
      const stranger = await githubUser(world, 'stranger');
      expectProblem(
        'completeProject',
        await complete(world, c.fx.backend, teamId()),
        403,
        'NOT_TEAM_LEAD',
      );
      expectProblem('completeProject', await complete(world, stranger, teamId()), 404, 'NOT_FOUND');
      const anonymous = await world.anonymous().post(`/v1/teams/${teamId()}/completion`);
      expectProblem('completeProject', anonymous, 401, 'UNAUTHENTICATED');
      expect((await complete(world, stranger, randomUUID())).statusCode).toBe(404);
      await expectStillOpen();
    });

    it('FR-WORK-13: after all these refusals the team is untouched and, once the check is fresh, completes', async () => {
      await runCheck(world, lead(), teamId());
      const response = await attempt();
      expect(response.statusCode, response.body).toBe(201);
    });
  },
);
