import { randomUUID } from 'node:crypto';
import { Queue } from 'bullmq';
import { Redis } from 'ioredis';
import { expect } from 'vitest';
import type { Schema } from 'shared';
import type { TwinPerson } from '../fakes/github-webhooks.js';
import type { InjectResponse } from '../helpers/http.js';
import { waitFor } from '../helpers/infra.js';
import { createTestWorker } from '../helpers/app.js';
import { complete, runCheck, type CompletionDto } from './completion.js';
import {
  closedIssueDelivered,
  connectRepository,
  ghPerson,
  mergedPullDelivered,
  type Connected,
} from './github.js';
import type { UserFixture } from './index.js';
import {
  DAY,
  expectOk,
  githubUser,
  joinThroughOffer,
  seatInput,
  type SeatDto,
  type TeamDto,
} from './teams.js';
import {
  advanceStage,
  clockOf,
  completeStageOne,
  completeStageTwo,
  doneWithLink,
  routeTeam,
  type RouteFixture,
} from './workspace.js';
import type { World } from './world.js';

/**
 * Slice 7 fixtures (docs/plan.md S7-01, written before the implementation of S7-02..S7-10).
 *
 * A project that is credited goes through the production path of slices 3-6 (a team, a started route, GitHub
 * work delivered by signed webhooks, the completion check, "Завершить"); the rewards are then driven through
 * the HTTP API and through the jobs of the worker. Where a scenario needs a state that is slow or impossible to
 * reach through the API, the fixture writes it with SQL and says so:
 *   - `plantDeficit`  : `teams.seat_assignment.deficit_at_join` (the rule itself is tested in slice 4);
 *   - `plantAccounts` : `github.account_check` (FR-GH-09; filled by the daily github-sync in production);
 *   - `plantHistory`  : earlier credited projects of a user in the `rewards` tables (series of 3, 5, 10 projects
 *                       would otherwise need as many full projects). The columns are those of architecture 5.9;
 *                       if the schema of S7-02 deviates, only this file changes.
 *
 * ASSUMPTIONS about the jobs (architecture 10.1, 13.12; the architecture names queue and job, not the payload):
 *   - `timers`      / `rewards-cooling-end`   data `{ teamId }`   = creditProject(teamId) at the end of cooling
 *   - `maintenance` / `credit-run-scan`, `pending-account-recheck`, `review-eligibility-scan`, `review-purge`
 *   - `timers`      / `review-publish`        data `{ teamId }`
 * If the implementation names a payload differently, only `runJobs` callers in this file and in
 * fixtures/reviews.ts change.
 */

export type BadgeListDto = Schema<'BadgeList'>;
export type BadgeDto = Schema<'Badge'>;
export type AwardListDto = Schema<'AwardList'>;
export type AwardDto = Schema<'Award'>;
export type CountersDto = Schema<'Counters'>;
export type CreditStatusDto = Schema<'CreditStatus'>;
export type DisputeDto = Schema<'Dispute'>;
export type FraudCaseDto = Schema<'FraudCase'>;
export type FraudCasePageDto = Schema<'FraudCasePage'>;

/** C-17b: the credit is applied this long after the completion. */
export const COOLING_MS = 7 * DAY;
const HOUR = 3_600_000;

// ---- API calls ----------------------------------------------------------------------------------

export const listBadges = (world: World, who: UserFixture): Promise<InjectResponse> =>
  world.as(who).get('/v1/badges');

export const userAwards = (
  world: World,
  who: UserFixture,
  userId: string,
): Promise<InjectResponse> => world.as(who).get(`/v1/users/${userId}/awards`);

export const userCounters = (
  world: World,
  who: UserFixture,
  userId: string,
): Promise<InjectResponse> => world.as(who).get(`/v1/users/${userId}/counters`);

export const teamCredit = (
  world: World,
  who: UserFixture,
  teamId: string,
): Promise<InjectResponse> => world.as(who).get(`/v1/teams/${teamId}/credit`);

export const awardsOk = async (
  world: World,
  who: UserFixture,
  userId: string,
): Promise<AwardDto[]> =>
  expectOk<AwardListDto>('listUserAwards', await userAwards(world, who, userId), 200).items;

export const countersOk = async (
  world: World,
  who: UserFixture,
  userId: string,
): Promise<CountersDto> =>
  expectOk<CountersDto>('getUserCounters', await userCounters(world, who, userId), 200);

export const creditOk = async (
  world: World,
  who: UserFixture,
  teamId: string,
): Promise<CreditStatusDto> =>
  expectOk<CreditStatusDto>('getTeamCredit', await teamCredit(world, who, teamId), 200);

export const DISPUTE_TEXT = 'Участники не вели общий репозиторий, вклад выглядит подозрительно.';

export function dispute(
  world: World,
  who: UserFixture,
  teamId: string,
  text: string = DISPUTE_TEXT,
  key?: string,
): Promise<InjectResponse> {
  return world
    .as(who)
    .post(`/v1/teams/${teamId}/disputes`, { text }, key === undefined ? {} : { idempotencyKey: key });
}

export function fraudCases(
  world: World,
  who: UserFixture,
  query: Record<string, string | number> = {},
): Promise<InjectResponse> {
  const suffix = Object.keys(query).length
    ? `?${new URLSearchParams(Object.entries(query).map(([k, v]): [string, string] => [k, String(v)])).toString()}`
    : '';
  return world.as(who).get(`/v1/admin/fraud-cases${suffix}`);
}

export const fraudCase = (world: World, who: UserFixture, caseId: string): Promise<InjectResponse> =>
  world.as(who).get(`/v1/admin/fraud-cases/${caseId}`);

export const DECISION_COMMENT = 'Проверено вручную: журнал коммитов и задач просмотрен.';

export function decide(
  world: World,
  who: UserFixture,
  caseId: string,
  decision: 'ok' | 'violation',
  key?: string,
  comment: string = DECISION_COMMENT,
): Promise<InjectResponse> {
  return world
    .as(who)
    .post(
      `/v1/admin/fraud-cases/${caseId}/decision`,
      { decision, comment },
      key === undefined ? {} : { idempotencyKey: key },
    );
}

/** The awards of a user by the NAME of FR-REW-05 (the codes of `badge_def` are the implementation's choice). */
export const awardNames = (awards: AwardDto[]): string[] => awards.map((a) => a.name).sort();

export const BADGE_NAMES = {
  projects: ['Первый релиз', 'Трое в строю', 'Пятёрка проектов', 'Десять из десяти'],
  roles: ['Многоликий', 'Универсал'],
  productTypes: ['Разные берега', 'Коллекционер форматов'],
  onTime: 'В срок',
  streak: 'Три в срок подряд',
  deficit: 'Закрыл дефицит',
  teamBonus: 'Закрытая вакансия',
} as const;

// ---- jobs of the worker ---------------------------------------------------------------------------

export interface JobOutcome {
  state: 'completed' | 'failed';
  reason?: string;
}

let jobSerial = 0;

/**
 * Adds `count` jobs to a queue at the same moment and waits until each finished. A job that no worker picks
 * up within 8 s means that its processor is not registered (not implemented yet): the call rejects with that
 * reason instead of the test timing out. A job that throws is reported, not thrown: some scenarios expect a
 * refusal of a repeated run to be a quiet no-op, others a failure, and say so themselves.
 */
export async function runJobs(
  world: World,
  queueName: 'timers' | 'maintenance',
  name: string,
  data: Record<string, unknown>,
  count = 1,
  idPart = 'x',
): Promise<JobOutcome[]> {
  const connection = new Redis(process.env.REDIS_URL ?? '', { maxRetriesPerRequest: null });
  const queue = new Queue(queueName, { connection, prefix: world.queuePrefix });
  try {
    const jobs = await Promise.all(
      Array.from({ length: count }, () => {
        jobSerial += 1;
        return queue.add(name, data, {
          jobId: `${name.replaceAll('-', '')}_${idPart}_test${world.runId}${jobSerial}`,
          removeOnComplete: false,
          removeOnFail: false,
          attempts: 1,
        });
      }),
    );
    const startedAt = Date.now();
    return await Promise.all(
      jobs.map((job) =>
        waitFor(
          async (): Promise<JobOutcome | false> => {
            const state = await job.getState();
            if (state === 'completed') return { state: 'completed' };
            if (state === 'failed') {
              const failed = await queue.getJob(job.id ?? '');
              return { state: 'failed', reason: failed?.failedReason ?? 'unknown' };
            }
            if (state === 'waiting' && Date.now() - startedAt > 8_000) {
              throw new Error(`job "${name}" of "${queueName}" is not picked up: no processor registered`);
            }
            return false;
          },
          60_000,
          50,
        ),
      ),
    );
  } finally {
    await queue.close();
    connection.disconnect();
  }
}

/** creditProject(teamId) as the cooling timer runs it (CC-6). */
export const runCoolingEnd = (world: World, teamId: string, count = 1): Promise<JobOutcome[]> =>
  runJobs(world, 'timers', 'rewards-cooling-end', { teamId }, count, teamId);

export const runCreditScan = (world: World): Promise<JobOutcome[]> =>
  runJobs(world, 'maintenance', 'credit-run-scan', {});

export const runPendingRecheck = (world: World, count = 1): Promise<JobOutcome[]> =>
  runJobs(world, 'maintenance', 'pending-account-recheck', {}, count);

/** More workers on the same database and queues: `rewards-cooling-end` runs 5 jobs at a time per worker. */
export async function extraWorkers(world: World, count: number): Promise<{ close(): Promise<void> }> {
  const workers = await Promise.all(
    Array.from({ length: count }, () =>
      createTestWorker({
        databaseUrl: world.db.url,
        queuePrefix: world.queuePrefix,
        env: { DATABASE_POOL_MAX: '20', SMTP_URL: world.mail.smtpUrl, ...world.options.env },
        ...(world.options.clock ? { clock: world.options.clock } : {}),
      }),
    ),
  );
  return { close: async () => void (await Promise.all(workers.map((w) => w.close()))) };
}

// ---- the project that is credited -----------------------------------------------------------------

export interface ProjectOptions {
  /** Additions of every merged pull request (default 150: three of them are 480 changed lines, AF-05 is quiet). 20 gives AF-05. */
  prLines?: number;
  /** Days between the last work of stage 3 and the closing of the route (default 14, C-06a). 40 makes the project late. */
  daysBeforeFinish?: number;
  /** Runs when stage `n` has just opened and before the work of that stage. */
  beforeStage?: Partial<Record<2 | 3, (project: Project) => Promise<void>>>;
  /** Runs when every stage is closed and before the completion check. */
  beforeCompletion?: (project: Project) => Promise<void>;
}

export interface Project {
  world: World;
  fx: RouteFixture;
  connected: Connected;
  lead: UserFixture;
  backend: UserFixture;
  frontend: UserFixture;
  twin: { backend: TwinPerson; frontend: TwinPerson };
  /** Members who joined during the route (`joinLate`), in join order. */
  joined: UserFixture[];
  completion?: CompletionDto;
}

let releaseSerial = 0;

type Work = ['issue' | 'pr', 'backend' | 'frontend'];
/** Ten counted contributions (AF-04), both developers in every stage; the lead has none. */
const WORK: Record<1 | 2 | 3, Work[]> = {
  1: [['issue', 'backend'], ['issue', 'frontend'], ['issue', 'backend'], ['pr', 'frontend']],
  2: [['issue', 'frontend'], ['issue', 'backend'], ['pr', 'backend']],
  3: [['issue', 'backend'], ['issue', 'frontend'], ['pr', 'frontend']],
};

async function deliverWork(project: Project, stage: 1 | 2 | 3, prLines: number): Promise<void> {
  for (const [kind, who] of WORK[stage]) {
    const author = project.twin[who];
    if (kind === 'issue') {
      await closedIssueDelivered(project.world, project.connected.repo, {
        author,
        assignees: [author],
      });
    } else {
      await mergedPullDelivered(project.world, project.connected.repo, {
        author,
        additions: prLines,
        deletions: 10,
      });
    }
  }
}

/**
 * The route of a project up to the point where "Завершить" can be pressed: a lead without contributions,
 * `backend` and `frontend` developers with work in every stage, 28-day mini playbook, repository with 12
 * commits from both, release link saved. Needs `startRouteWorld({ github: true, clock })` and a fake link
 * checker (see `finishProject`).
 */
export async function buildProject(world: World, options: ProjectOptions = {}): Promise<Project> {
  const clock = clockOf(world);
  const fx = await routeTeam(world);
  const connected = await connectRepository(world, fx.team, [fx.backend, fx.frontend], {
    repo: { createdAt: clock.now().toISOString() },
  });
  const project: Project = {
    world,
    fx,
    connected,
    lead: fx.lead,
    backend: fx.backend,
    frontend: fx.frontend,
    twin: { backend: await ghPerson(world, fx.backend), frontend: await ghPerson(world, fx.frontend) },
    joined: [],
  };
  const prLines = options.prLines ?? 150;
  releaseSerial += 1;
  const releaseUrl = `https://app-${world.runId}-${releaseSerial}.release.example.test/`;
  await deliverWork(project, 1, prLines);
  await completeStageOne(fx);
  await advanceStage(fx, 1);
  await options.beforeStage?.[2]?.(project);
  await deliverWork(project, 2, prLines);
  await completeStageTwo(fx);
  await advanceStage(fx, 2);
  await options.beforeStage?.[3]?.(project);
  await deliverWork(project, 3, prLines);
  await doneWithLink(fx, 'mini_final_links', fx.frontend, 3, releaseUrl);
  clock.advance((options.daysBeforeFinish ?? 14) * DAY);
  await advanceStage(fx, 3);
  await options.beforeCompletion?.(project);
  return project;
}

/** Checks, "Завершить" (201) and the wait until rewards has opened its `credit_run`. */
export async function finishProject(project: Project): Promise<CompletionDto> {
  const { world, fx } = project;
  await runCheck(world, fx.lead, fx.team.id);
  const response = await complete(world, fx.lead, fx.team.id);
  expect(response.statusCode, response.body).toBe(201);
  const completion = expectOk<CompletionDto>('completeProject', response, 201);
  project.completion = completion;
  await waitFor(async () => (await creditRunStatus(world, fx.team.id)) !== undefined, 30_000);
  return completion;
}

/** A credited project of the standard shape, from the first webhook to the open `credit_run`. */
export async function completedProject(
  world: World,
  options: ProjectOptions = {},
): Promise<Project> {
  const project = await buildProject(world, options);
  await finishProject(project);
  return project;
}

export const membersOf = (project: Project): UserFixture[] => [
  project.lead,
  project.backend,
  project.frontend,
  ...project.joined,
];

/** Time passes C-17b + 1 h and the cooling timer fires (n times at once). All members have a good GitHub account. */
export async function endCooling(
  project: Project,
  options: { count?: number; plant?: boolean } = {},
): Promise<JobOutcome[]> {
  const { world, fx } = project;
  if (options.plant !== false) await plantAccounts(world, membersOf(project));
  clockOf(world).advance(COOLING_MS + HOUR);
  return runCoolingEnd(world, fx.team.id, options.count ?? 1);
}

// ---- people who join the route ---------------------------------------------------------------------

async function openSeat(world: World, project: Project, roleCode: string): Promise<SeatDto> {
  const read = async (): Promise<SeatDto | undefined> =>
    expectOk<TeamDto>('getTeam', await world.as(project.lead).get(`/v1/teams/${project.fx.team.id}`), 200)
      .seats.find((s) => s.roleCode === roleCode && s.status === 'open');
  const existing = await read();
  if (existing) return existing;
  const added = await world
    .as(project.lead)
    .post(`/v1/teams/${project.fx.team.id}/seats`, { seats: [seatInput({ roleCode })] });
  expect(added.statusCode, added.body).toBe(201);
  const created = await read();
  if (!created) throw new Error(`no open ${roleCode} seat after addSeats`);
  return created;
}

/** A new person takes a seat of `roleCode` (the open one, or a new one) through an offer and an acceptance. */
export async function joinLate(
  project: Project,
  roleCode = 'devops',
  options: { contributes?: number } = {},
): Promise<UserFixture> {
  const { world } = project;
  const user = await githubUser(world, `late-${roleCode}`);
  await joinThroughOffer(world, project.lead, project.fx.team.id, (await openSeat(world, project, roleCode)).id, user);
  project.joined.push(user);
  await contribute(project, user, options.contributes ?? 0);
  return user;
}

/** `count` closed issues of the member's GitHub account arrive by webhook now (a contribution in the open stage). */
export async function contribute(project: Project, who: UserFixture, count = 1): Promise<void> {
  const person = await ghPerson(project.world, who);
  for (let i = 0; i < count; i += 1) {
    await closedIssueDelivered(project.world, project.connected.repo, { author: person, assignees: [person] });
  }
}

/** An existing member takes a second seat (combined roles, C-03). */
export async function takeSecondRole(project: Project, who: UserFixture, roleCode = 'devops'): Promise<void> {
  const { world } = project;
  await joinThroughOffer(world, project.lead, project.fx.team.id, (await openSeat(world, project, roleCode)).id, who);
}

/** The member leaves before the completion (FR-TEAM-11); the seat opens again. */
export async function leaveEarly(project: Project, who: UserFixture): Promise<void> {
  const response = await project.world.as(who).delete(`/v1/teams/${project.fx.team.id}/members/me`);
  expect(response.statusCode, response.body).toBe(204);
}

/** The lead marks the seat of `roleCode` as desired (FR-TEAM-03). */
export async function markDesired(project: Project, roleCode: string, desired = true): Promise<void> {
  const { world } = project;
  const team = expectOk<TeamDto>('getTeam', await world.as(project.lead).get(`/v1/teams/${project.fx.team.id}`), 200);
  const seat = team.seats.find((s) => s.roleCode === roleCode && s.holderUserId !== null);
  if (!seat) throw new Error(`no held ${roleCode} seat`);
  const response = await world
    .as(project.lead)
    .patch(`/v1/teams/${project.fx.team.id}/seats/${seat.id}`, { version: seat.version, desired });
  expect(response.statusCode, response.body).toBe(200);
}

/** Moves one contribution of `who` to another of his roles (FR-WORK-17), so that the second role has a contribution. */
export async function relabelOneContribution(
  project: Project,
  who: UserFixture,
  roleCode: string,
): Promise<void> {
  const { world } = project;
  const feed = await world.as(who).get(`/v1/teams/${project.fx.team.id}/feed?limit=100&userId=${who.id}`);
  const own = feed.json<{ items: { id: string; userId: string }[] }>().items.find((e) => e.userId === who.id);
  if (!own) throw new Error('the member has no contribution to relabel');
  const response = await world
    .as(who)
    .patch(`/v1/teams/${project.fx.team.id}/contributions/${own.id}`, { roleCode });
  expect(response.statusCode, response.body).toBe(200);
}

// ---- planted state ----------------------------------------------------------------------------------

/** `teams.seat_assignment.deficit_at_join` of the active assignment of `who` in the team (see the header). */
export async function plantDeficit(
  world: World,
  teamId: string,
  who: UserFixture,
  deficit: boolean,
): Promise<void> {
  await world.sql`
    UPDATE teams.seat_assignment SET deficit_at_join = ${deficit}
     WHERE team_id = ${teamId} AND user_id = ${who.id}`;
}

/** `github.account_check` (FR-GH-09): age in days and the public repositories of the GitHub account of each user. */
export async function plantAccounts(
  world: World,
  users: UserFixture[],
  options: { ageDays?: number; publicRepos?: number; publicActivity?: boolean } = {},
): Promise<void> {
  const created = new Date(clockOf(world).now().getTime() - (options.ageDays ?? 400) * DAY);
  for (const user of users) {
    const person = await ghPerson(world, user);
    await world.sql`
      INSERT INTO github.account_check (github_user_id, account_created_at, public_repos, has_public_activity, checked_at)
      VALUES (${person.id}, ${created}, ${options.publicRepos ?? 3}, ${options.publicActivity ?? true}, ${clockOf(world).now()})
      ON CONFLICT (github_user_id) DO UPDATE
        SET account_created_at = EXCLUDED.account_created_at, public_repos = EXCLUDED.public_repos,
            has_public_activity = EXCLUDED.has_public_activity, checked_at = EXCLUDED.checked_at`;
  }
}

export interface PlantedProject {
  roles: string[];
  productType?: string;
  overdueDays?: number;
  /** Days before the clock now. */
  completedDaysAgo: number;
  status?: 'credited' | 'denied';
  /** Same value = same composition of the team (AF-13). Default: a distinct one per project. */
  roster?: string;
}

let plantedSerial = 0;

/**
 * Earlier projects of a user in the rewards tables, with counters and the series awards they would have
 * produced, so that a test needs one real project to cross a threshold (3rd, 5th, 10th project; the 3rd
 * on-time project in a row). Only `credited` projects count in counters.
 */
export async function plantHistory(
  world: World,
  user: UserFixture,
  projects: PlantedProject[],
): Promise<string[]> {
  const now = clockOf(world).now();
  const teamIds: string[] = [];
  for (const planted of projects) {
    plantedSerial += 1;
    const id = randomUUID();
    const completedAt = new Date(now.getTime() - planted.completedDaysAgo * DAY);
    const roster = Buffer.from(planted.roster ?? `planted-${world.runId}-${plantedSerial}`.padEnd(32, '0')).subarray(0, 32);
    const status = planted.status ?? 'credited';
    await world.sql`
      INSERT INTO rewards.credit_run (team_id, completed_at, cooling_until, status, roster_hash, fraud_score, credited_at, version)
      VALUES (${id}, ${completedAt}, ${new Date(completedAt.getTime() + COOLING_MS)}, 'credited', ${roster}, 0, ${completedAt}, 1)`;
    await world.sql`
      INSERT INTO rewards.project_credit (team_id, user_id, status, reason, product_type_code, overdue_days, completed_at, roster_hash, decided_at)
      VALUES (${id}, ${user.id}, ${status}, ${status === 'denied' ? 'no_contribution' : null},
              ${planted.productType ?? 'web_service'}, ${planted.overdueDays ?? 0}, ${completedAt}, ${roster}, ${completedAt})`;
    for (const roleCode of status === 'credited' ? planted.roles : []) {
      await world.sql`
        INSERT INTO rewards.credit (team_id, user_id, role_code, status, deficit_at_join, credited_at)
        VALUES (${id}, ${user.id}, ${roleCode}, 'credited', false, ${completedAt})`;
    }
    teamIds.push(id);
  }
  const credited = projects.filter((p) => (p.status ?? 'credited') === 'credited');
  if (credited.length > 0) {
    await world.sql`
      INSERT INTO rewards.counter (user_id, role_code, value) VALUES (${user.id}, NULL, ${credited.length})
      ON CONFLICT (user_id, role_code) DO UPDATE SET value = rewards.counter.value + EXCLUDED.value`;
    const perRole = new Map<string, number>();
    for (const p of credited) for (const r of new Set(p.roles)) perRole.set(r, (perRole.get(r) ?? 0) + 1);
    for (const [roleCode, value] of perRole) {
      await world.sql`
        INSERT INTO rewards.counter (user_id, role_code, value) VALUES (${user.id}, ${roleCode}, ${value})
        ON CONFLICT (user_id, role_code) DO UPDATE SET value = rewards.counter.value + EXCLUDED.value`;
    }
  }
  return teamIds;
}

// ---- state reads (SQL) ------------------------------------------------------------------------------

export async function creditRunStatus(world: World, teamId: string): Promise<string | undefined> {
  const rows = await world.sql<{ status: string }[]>`
    SELECT status FROM rewards.credit_run WHERE team_id = ${teamId}`;
  return rows[0]?.status;
}

/** Waits until `credit_run` of the team has `status` (the timer, the event or an administrator moved it). */
export async function waitCreditRun(world: World, teamId: string, status: string): Promise<void> {
  await waitFor(async () => (await creditRunStatus(world, teamId)) === status, 30_000);
}

/** The open fraud case of a frozen project (`fraud_case`), through the administrator's queue. */
export async function openCaseOf(world: World, admin: UserFixture, teamId: string): Promise<FraudCaseDto> {
  const page = expectOk<FraudCasePageDto>('listFraudCases', await fraudCases(world, admin, { status: 'open', limit: 100 }), 200);
  const found = page.items.find((c) => c.teamId === teamId);
  if (!found) throw new Error(`no open fraud case for team ${teamId}`);
  return found;
}
