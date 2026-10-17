import type { TestingModuleBuilder } from '@nestjs/testing';
import { Queue } from 'bullmq';
import { Redis } from 'ioredis';
import postgres from 'postgres';
import { expect } from 'vitest';
import { APP_CONFIG } from '../../src/platform/config/config.module.js';
import type { AppConfig } from '../../src/platform/config/config.js';
import { PG_CLIENT } from '../../src/platform/db/db.module.js';
import { createTestWorker } from '../helpers/app.js';
import { waitFor } from '../helpers/infra.js';
import type { UserFixture } from './index.js';
import { insertProfile, PROFILE_STACK, type ProfileInputBody } from './profiles.js';
import {
  expectOk,
  githubUser,
  team,
  userWithoutGithub,
  type MemberDto,
  type SeatDto,
  type TeamDto,
  type TeamFixture,
  type TeamOptions,
} from './teams.js';
import type { World } from './world.js';

/**
 * Slice 4 fixtures (docs/plan.md, "Фикстуры": `searchApplication`, `teamWithDemand`).
 *
 * Same deviation as slice 3, on purpose: builders go through the public API (createTeam,
 * createSearchApplication, ...) because computed fields (`enqueued_at`, `version`, `trial_until`,
 * `deficit_*`) must come from the production code. Users and profiles are inserted directly.
 *
 * ISOLATION RULE of the slice 4 suites: the worker of a `World` runs `matching-auto-add` on its own
 * (every minute and 5 s after `seat_opened` / `application_changed`), so an application left active
 * by one test would be auto-added into a seat built by another. Every test therefore works with its
 * own role code (`freshRole`): seats, applications and profile preferences of a test never match
 * anything of another test.
 */

export const DAY = 24 * 3_600_000;
/** C-11: the trial period of an auto-added member. */
export const TRIAL_MS = 7 * DAY;

export interface ApplicationRoleDto {
  roleCode: string;
  priority: number;
  addedAt: string;
}

export interface SearchApplicationDto {
  id: string;
  status: 'active' | 'fulfilled' | 'cancelled';
  enqueuedAt: string;
  roles: ApplicationRoleDto[];
  version: number;
}

export interface RoleDemandDto {
  roleCode: string;
  teamsSeeking: number;
  openSeats: number;
  queuedCandidates: number;
  avgWaitSeconds: number | null;
  avgWaitStatus: 'ok' | 'insufficient_data';
  deficit: boolean;
  computedAt: string;
}

export interface MatchReasonsDto {
  role: boolean;
  stack: number;
  level: number;
  timezone: number;
  availability: number;
  completedProjects: number;
  matchedStackTags: string[];
  timezoneDiffHours?: number;
}

export interface TeamRecommendationDto {
  teamId: string;
  teamName: string;
  seatId: string;
  roleCode: string;
  score: number;
  reasons: MatchReasonsDto;
  computedAt: string;
}

export interface CandidateRecommendationDto {
  userId: string;
  displayName: string;
  score: number;
  reasons: MatchReasonsDto;
  inQueue: boolean;
  computedAt: string;
}

export interface Page<T> {
  items: T[];
  nextCursor: string | null;
}

let serial = 0;
const nextSerial = (): number => {
  serial += 1;
  return serial;
};

/** A role of the catalog used by one test only (RoleCode: `^[a-z][a-z0-9_]{1,31}$`). */
export async function freshRole(world: World): Promise<string> {
  const code = `m4_${world.runId}_${nextSerial()}`;
  await world.ensureCatalog([code], PROFILE_STACK);
  return code;
}

export interface CandidateOptions {
  /** Roles in the profile (`rolePrefs`); default: none beyond `roles`. */
  roles?: string[];
  level?: 'beginner' | 'junior' | 'middle';
  hoursPerWeek?: number;
  timezone?: string;
  stack?: string[];
  /** A person without a linked GitHub account (GITHUB_REQUIRED). */
  github?: boolean;
  profile?: Partial<ProfileInputBody>;
}

/**
 * A person who can stand in the queue: GitHub linked, consent recorded and a profile whose role
 * preferences are `roles` (so that a seat of that role passes the hard filters of FR-MATCH-12:
 * level >= seat minimum, hours >= seat minimum, same time zone as the default team).
 */
export async function candidate(
  world: World,
  label: string,
  options: CandidateOptions = {},
): Promise<UserFixture> {
  const user =
    options.github === false
      ? await userWithoutGithub(world, label)
      : await githubUser(world, label);
  await world.ensureCatalog(options.roles ?? [], PROFILE_STACK);
  await insertProfile(world.sql, user.id, {
    displayName: label,
    hoursPerWeek: options.hoursPerWeek ?? 12,
    timezone: options.timezone ?? 'Europe/Moscow',
    stack: options.stack ?? ['typescript'],
    rolePrefs: (options.roles ?? []).map((roleCode) => ({
      roleCode,
      level: options.level ?? 'junior',
    })),
    ...options.profile,
  });
  return user;
}

/** `SearchApplicationInput`: priorities follow the list order (1 = highest). */
export const applicationBody = (
  roleCodes: string[],
): { roles: { roleCode: string; priority: number }[] } => ({
  roles: roleCodes.map((roleCode, index) => ({ roleCode, priority: index + 1 })),
});

export interface SearchApplicationFixture {
  user: UserFixture;
  application: SearchApplicationDto;
  roles: string[];
}

/** `searchApplication({ roles })`: a candidate with a profile for `roles` standing in the queue (priority = list order). */
export async function searchApplication(
  world: World,
  options: CandidateOptions & { roles: string[]; user?: UserFixture; label?: string },
): Promise<SearchApplicationFixture> {
  const user = options.user ?? (await candidate(world, options.label ?? 'queued', options));
  const application = expectOk<SearchApplicationDto>(
    'createSearchApplication',
    await world.as(user).post('/v1/me/search-application', applicationBody(options.roles)),
    201,
  );
  return { user, application, roles: options.roles };
}

export interface TeamWithDemandOptions extends Omit<TeamOptions, 'roleCode'> {
  /** Role of the open seats; default: a `freshRole`. */
  roleCode?: string;
  /** People standing in the queue (default 0). */
  queued?: number;
  /** Role the queued people ask for (default: the role of the seats; see the isolation rule above). */
  queueRole?: string;
  /** Applied to every open seat through `updateSeat` (FR-TEAM-02) after the team is built. */
  seat?: { minLevel?: 'beginner' | 'junior' | 'middle'; minHours?: number; stack?: string[] };
}

export interface TeamWithDemand extends TeamFixture {
  roleCode: string;
  queuedApplications: SearchApplicationFixture[];
}

/**
 * `teamWithDemand({ openSeats, queued })`: a team with open seats of one role and people standing in
 * the queue for a role. With the default `queueRole` the queued people match the seats, so the
 * auto-add worker will take them: use a `World` started with `worker: false` or give `queueRole`
 * another role when the test needs the queue to stay as built.
 */
export async function teamWithDemand(
  world: World,
  options: TeamWithDemandOptions = {},
): Promise<TeamWithDemand> {
  const roleCode = options.roleCode ?? (await freshRole(world));
  const base = await team(world, {
    ...options,
    roleCode,
    openSeats: options.openSeats ?? 1,
  });
  let current = base;
  if (options.seat) {
    for (const seat of base.openSeats) {
      expectOk(
        'updateSeat',
        await world.as(base.lead).patch(`/v1/teams/${base.id}/seats/${seat.id}`, {
          ...options.seat,
          version: seat.version,
        }),
        200,
      );
    }
    const dto = expectOk<TeamDto>(
      'getTeam',
      await world.as(base.lead).get(`/v1/teams/${base.id}`),
      200,
    );
    current = {
      ...base,
      dto,
      seats: dto.seats,
      openSeats: dto.seats.filter((s) => s.status === 'open'),
    };
  }
  const queueRole = options.queueRole ?? roleCode;
  const queuedApplications: SearchApplicationFixture[] = [];
  for (let i = 0; i < (options.queued ?? 0); i += 1) {
    queuedApplications.push(
      await searchApplication(world, { roles: [queueRole], label: `queued-${i}` }),
    );
  }
  return { ...current, roleCode, queuedApplications };
}

// ---- background jobs ---------------------------------------------------------------------------

let jobSequence = 0;

/**
 * Waits until a job of `queue` finished (removed on completion counts as finished). A job that no
 * worker picks up within 6 s means that its processor is not registered (not implemented yet): the
 * test fails with that reason instead of waiting for its own timeout.
 */
async function waitForJob(queue: Queue, jobId: string): Promise<void> {
  const startedAt = Date.now();
  await waitFor(
    async () => {
      const job = await queue.getJob(jobId);
      if (!job) return true;
      const state = await job.getState();
      if (state === 'failed') throw new Error(`job ${jobId} failed: ${job.failedReason}`);
      if (state === 'completed') return true;
      if (state === 'waiting' && Date.now() - startedAt > 6_000) {
        throw new Error(
          `job ${jobId} of "${queue.name}" is not picked up: no processor registered`,
        );
      }
      return false;
    },
    30_000,
    50,
  );
}

async function withQueue<T>(
  world: World,
  name: string,
  body: (queue: Queue) => Promise<T>,
): Promise<T> {
  const connection = new Redis(process.env.REDIS_URL ?? '', { maxRetriesPerRequest: null });
  const queue = new Queue(name, { connection, prefix: world.queuePrefix });
  try {
    return await body(queue);
  } finally {
    await queue.close();
    connection.disconnect();
  }
}

/**
 * Runs the `matching-auto-add` job (architecture 6.4, 13.12: queue and job name `matching-auto-add`,
 * no payload) NOW and waits until it finished. `parallel` jobs are released together; they truly
 * overlap only with that many workers (the queue concurrency is 1 per worker): use
 * `startExtraWorkers` for CC-3. If the implementation names the queue or the job differently, only
 * this helper needs to change.
 */
export async function runAutoAdd(world: World, parallel = 1): Promise<void> {
  await withQueue(world, 'matching-auto-add', async (queue) => {
    const ids = Array.from({ length: parallel }, () => {
      jobSequence += 1;
      return `autoadd_test${world.runId}${jobSequence}`;
    });
    await Promise.all(
      ids.map((jobId) =>
        queue.add('matching-auto-add', {}, { jobId, removeOnComplete: false, removeOnFail: false }),
      ),
    );
    await Promise.all(ids.map((jobId) => waitForJob(queue, jobId)));
  });
}

/**
 * Additional worker processes on the same database and queue prefix as the world (a `World` has one
 * worker). Start the world with `worker: false` and bring `count` workers when the test needs real
 * parallel `runAutoAdd`s. Close them in `afterAll` before the world.
 */
export async function startExtraWorkers(
  world: World,
  count: number,
): Promise<{ close(): Promise<void> }> {
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
  return {
    async close() {
      await Promise.all(workers.map((w) => w.close()));
    },
  };
}

/**
 * Fires the `trial-expire` timer of a membership now (architecture 13.12, `timers` queue). The data
 * shape `{ membershipId }` is an assumption of this suite (the architecture names the job only); like
 * `fireTimer` of slice 3, only this helper needs to change if the payload differs.
 */
export async function fireTrialExpire(world: World, membershipId: string): Promise<void> {
  await withQueue(world, 'timers', async (queue) => {
    jobSequence += 1;
    const jobId = `trialexpire_${membershipId}_test${jobSequence}`;
    await queue.add('trial-expire', { membershipId }, { jobId, removeOnComplete: false });
    await waitForJob(queue, jobId);
  });
}

// ---- auto-added members --------------------------------------------------------------------------

/** Waits until the application is `fulfilled` (auto-add done), returns its row. */
export async function waitFulfilled(world: World, applicationId: string): Promise<void> {
  await waitFor(async () => {
    const rows = await world.sql<{ status: string }[]>`
      SELECT status FROM matching.search_application WHERE id = ${applicationId}`;
    return rows[0]?.status === 'fulfilled';
  }, 30_000);
}

export interface AutoAddedMember extends TeamFixture {
  roleCode: string;
  member: UserFixture;
  application: SearchApplicationDto;
  seat: SeatDto;
  /** The member as `getTeam` shows him right after the auto-add. */
  dto: TeamDto;
  memberDto: MemberDto;
  membershipId: string;
}

export interface AutoAddedOptions {
  /** Further open seats of the team besides the one that gets filled (default 0). */
  extraOpenSeats?: number;
  status?: 'forming' | 'active';
  members?: number;
}

/**
 * A team whose only open seat was filled by `matching-auto-add` from the queue: the member has
 * `joinedVia = 'auto'` and `trialUntil` = join + 7 days (FR-MATCH-05). Built through the production
 * path (needs a worker in the world).
 */
export async function autoAddedMember(
  world: World,
  options: AutoAddedOptions = {},
): Promise<AutoAddedMember> {
  const roleCode = await freshRole(world);
  const t = await team(world, {
    members: options.members ?? 2,
    openSeats: 1 + (options.extraOpenSeats ?? 0),
    ...(options.status ? { status: options.status } : {}),
    roleCode,
  });
  const seat = t.openSeats[0];
  if (!seat) throw new Error('autoAddedMember: no open seat');
  const queued = await searchApplication(world, { roles: [roleCode], label: 'auto-member' });
  await runAutoAdd(world);
  await waitFulfilled(world, queued.application.id);
  const dto = expectOk<TeamDto>('getTeam', await world.as(t.lead).get(`/v1/teams/${t.id}`), 200);
  const memberDto = dto.members.find((m) => m.userId === queued.user.id);
  if (!memberDto) throw new Error('autoAddedMember: the candidate is not a member');
  const rows = await world.sql<{ id: string }[]>`
    SELECT id FROM teams.membership WHERE team_id = ${t.id} AND user_id = ${queued.user.id}`;
  const membershipId = rows[0]?.id;
  if (!membershipId) throw new Error('autoAddedMember: no membership row');
  return {
    ...t,
    dto,
    roleCode,
    member: queued.user,
    application: queued.application,
    seat,
    memberDto,
    membershipId,
  };
}

/**
 * Marks an existing member as auto-added by SQL (`joined_via = 'auto'`, a trial of 7 days from the
 * world's clock): for suites that test authorization and need the state, not the path to it.
 */
export async function markAutoAdded(
  world: World,
  teamId: string,
  userId: string,
  trialUntil: Date = new Date((world.options.clock?.now().getTime() ?? Date.now()) + TRIAL_MS),
): Promise<void> {
  await world.sql`
    UPDATE teams.membership SET joined_via = 'auto', trial_until = ${trialUntil}, trial_confirmed_at = NULL
     WHERE team_id = ${teamId} AND user_id = ${userId} AND status = 'active'`;
}

// ---- SQL query counting --------------------------------------------------------------------------

export interface QueryCounter {
  /** Pass as `World.start({ customizeApp })`: the API application then talks to PostgreSQL through a counting client. */
  customizeApp(builder: TestingModuleBuilder): TestingModuleBuilder;
  reset(): void;
  /** Statements sent since `reset()` (BEGIN, SET LOCAL and COMMIT of the transaction wrapper included). */
  count(): number;
  statements(): string[];
}

/**
 * Counts the statements the API application sends (postgres.js `debug` hook on a replacement of the
 * `PG_CLIENT` provider). The harness has no other query counter; the worker keeps its own client, so
 * only the HTTP application is measured.
 */
export function queryCounter(): QueryCounter {
  const seen: string[] = [];
  return {
    customizeApp: (builder) =>
      builder.overrideProvider(PG_CLIENT).useFactory({
        inject: [APP_CONFIG],
        factory: (config: AppConfig) =>
          postgres(config.DATABASE_URL, {
            prepare: false,
            max: config.DATABASE_POOL_MAX,
            idle_timeout: 30,
            connect_timeout: 10,
            onnotice: () => undefined,
            debug: (_connection, query) => {
              seen.push(String(query));
            },
            connection: { application_name: 'teamforge-api-counted' },
          }),
      }),
    reset: () => {
      seen.length = 0;
    },
    count: () => seen.length,
    statements: () => [...seen],
  };
}

/** `getTeam` of `teamId` as `viewer`. */
export async function readTeam(
  world: World,
  viewer: UserFixture,
  teamId: string,
): Promise<TeamDto> {
  return expectOk<TeamDto>('getTeam', await world.as(viewer).get(`/v1/teams/${teamId}`), 200);
}

export function expectApplicationShape(application: SearchApplicationDto): void {
  expect(application.roles.length).toBeGreaterThanOrEqual(1);
  expect(new Set(application.roles.map((r) => r.priority)).size).toBe(application.roles.length);
}
