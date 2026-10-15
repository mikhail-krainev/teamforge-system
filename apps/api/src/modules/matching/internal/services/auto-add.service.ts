import { Inject, Injectable } from '@nestjs/common';
import { uuidv7 } from 'uuidv7';
import { Clock } from '../../../../platform/clock/clock.js';
import { DomainError } from '../../../../platform/errors/domain-error.js';
import { OutboxService } from '../../../../platform/outbox/outbox.service.js';
import { LockService } from '../../../../platform/tx/locks.js';
import { TxRunner } from '../../../../platform/tx/tx-runner.js';
import { AUTH_API, type AuthApi } from '../../../auth/public.js';
import { PROFILES_API, type MatchingProfile, type ProfilesApi } from '../../../profiles/public.js';
import {
  TEAMS_API,
  type JoinRejectCode,
  type JoinSeatResult,
  type OpenSeatView,
  type TeamsApi,
} from '../../../teams/public.js';
import { type AutoAddPair, orderPairs } from '../domain/auto-add-rules.js';
import { AUTO_ADD_THRESHOLD, evaluatePair, isPairAllowed, levelInRole } from '../domain/score.js';
import { ApplicationRepository } from '../repositories/application.repository.js';
import type { ApplicationRow } from '../repositories/application.repository.js';
import {
  AutoAddRepository,
  type QueuedApplication,
  type QueuedRole,
  type QueuePosition,
} from '../repositories/auto-add.repository.js';
import { CandidateStatsRepository } from '../repositories/candidate-stats.repository.js';
import { applicationChanged, matchingEvent } from './matching-events.js';

/** Applications read per page of one run. */
const APPLICATION_PAGE = 100;
/** Open seats per page of `listOpenSeats`. */
const SEAT_PAGE = 500;
const NO_TEAMS: ReadonlySet<string> = new Set();
const NO_COUNTS: ReadonlyMap<string, number> = new Map();

/** Refusals after which the whole application waits for the next run (architecture 6.4). */
const SKIPS_APPLICATION: ReadonlySet<string> = new Set<JoinRejectCode | 'LOCK_TIMEOUT'>([
  'PROJECT_LIMIT',
  'GITHUB_REQUIRED',
  'CONSENT_REQUIRED',
  'USER_INACTIVE',
  'LOCK_TIMEOUT',
]);
/** Refusals that say the seat is gone for everybody, not only for this person. */
const SEAT_GONE: ReadonlySet<string> = new Set<JoinRejectCode>([
  'SEAT_TAKEN',
  'SEAT_NOT_OPEN',
  'TEAM_FULL',
  'INVALID_STATE',
]);

export interface AutoAddReport {
  runId: string;
  /** Active applications looked at. */
  applications: number;
  added: number;
  /** Pairs that were tried and lost: a race, a limit, a refusal of the join. */
  skipped: number;
}

type Attempt =
  | { kind: 'added' }
  | { kind: 'next-pair'; reason: string }
  | { kind: 'skip-application'; reason: string };

interface PageContext {
  roles: Map<string, QueuedRole[]>;
  profiles: Map<string, MatchingProfile>;
  exclusions: Map<string, Set<string>>;
  /** Completed projects per role of each person of the page. */
  completed: Map<string, Map<string, number>>;
}

/** What a run remembers between its applications. */
interface RunState {
  runId: string;
  now: Date;
  report: AutoAddReport;
  /** Seats filled or found gone during this run. */
  gone: Set<string>;
  seatsByRole: Map<string, Promise<OpenSeatView[]>>;
}

/**
 * The `matching-auto-add` run (FR-MATCH-05..07, architecture 6.4). Applications are served by
 * `enqueued_at` (the longest waiting gets a contested seat first); the pairs of one application are
 * tried in the order of `orderPairs`. Every pair is its own transaction T2: lock #1 (user) -> #2
 * (application) -> `TeamsApi.joinSeat` (#4 team, #5 seat). A repeated or parallel run is harmless: it
 * meets the locks and the unique indexes, sees `fulfilled` and goes on.
 */
@Injectable()
export class AutoAddService {
  constructor(
    @Inject(Clock) private readonly clock: Clock,
    @Inject(TxRunner) private readonly tx: TxRunner,
    @Inject(LockService) private readonly locks: LockService,
    @Inject(OutboxService) private readonly outbox: OutboxService,
    @Inject(AUTH_API) private readonly auth: AuthApi,
    @Inject(PROFILES_API) private readonly profiles: ProfilesApi,
    @Inject(TEAMS_API) private readonly teams: TeamsApi,
    @Inject(ApplicationRepository) private readonly applications: ApplicationRepository,
    @Inject(AutoAddRepository) private readonly queue: AutoAddRepository,
    @Inject(CandidateStatsRepository) private readonly stats: CandidateStatsRepository,
  ) {}

  async run(): Promise<AutoAddReport> {
    const runId = uuidv7();
    const state: RunState = {
      runId,
      now: this.clock.now(),
      report: { runId, applications: 0, added: 0, skipped: 0 },
      gone: new Set(),
      seatsByRole: new Map(),
    };
    let after: QueuePosition | undefined;
    for (;;) {
      const page = await this.queue.activeApplications(after, APPLICATION_PAGE);
      if (page.length === 0) break;
      const context = await this.contextOf(page);
      for (const application of page) {
        state.report.applications += 1;
        await this.serve(state, context, application);
      }
      const last = page.at(-1);
      if (page.length < APPLICATION_PAGE || last === undefined) break;
      after = { enqueuedAt: last.enqueuedAt, id: last.id };
    }
    return state.report;
  }

  private async contextOf(page: QueuedApplication[]): Promise<PageContext> {
    const ids = page.map((application) => application.id);
    const userIds = page.map((application) => application.userId);
    const [roles, profiles, exclusions, completed] = await Promise.all([
      this.queue.activeRoles(ids),
      // Eligibility is checked again under lock #1 (and logged there), so the run reads the profile
      // of a person whose account is being deleted too.
      this.profiles.getMatchingProfiles(userIds, { includeIneligible: true }),
      this.queue.exclusions(ids),
      this.stats.completedByUsers(userIds),
    ]);
    return { roles, profiles: new Map(profiles.map((p) => [p.userId, p])), exclusions, completed };
  }

  /** Open seats of a role, read once per run. */
  private seatsOf(state: RunState, roleCode: string): Promise<OpenSeatView[]> {
    let found = state.seatsByRole.get(roleCode);
    if (found === undefined) {
      found = this.readSeats(roleCode);
      state.seatsByRole.set(roleCode, found);
    }
    return found;
  }

  private async readSeats(roleCode: string): Promise<OpenSeatView[]> {
    const seats: OpenSeatView[] = [];
    let after: string | undefined;
    for (;;) {
      const page = await this.teams.listOpenSeats({
        roleCodes: [roleCode],
        limit: SEAT_PAGE,
        ...(after === undefined ? {} : { afterSeatId: after }),
      });
      seats.push(...page);
      if (page.length < SEAT_PAGE) return seats;
      after = page.at(-1)?.seatId;
    }
  }

  private async serve(
    state: RunState,
    context: PageContext,
    application: QueuedApplication,
  ): Promise<void> {
    const profile = context.profiles.get(application.userId);
    if (profile === undefined) return;
    const pairs = await this.pairsOf(
      state,
      application,
      profile,
      context.roles.get(application.id) ?? [],
      context.exclusions.get(application.id) ?? NO_TEAMS,
      context.completed.get(application.userId) ?? NO_COUNTS,
    );
    for (const pair of orderPairs(pairs)) {
      if (state.gone.has(pair.seatId)) continue;
      const attempt = await this.attempt(state.runId, application, pair);
      if (attempt.kind === 'added') {
        state.report.added += 1;
        state.gone.add(pair.seatId);
        return;
      }
      state.report.skipped += 1;
      if (SEAT_GONE.has(attempt.reason)) state.gone.add(pair.seatId);
      if (attempt.kind === 'skip-application') return;
    }
  }

  /** Pairs "role of the application x open seat" that pass the filters and the threshold (C-45). */
  private async pairsOf(
    state: RunState,
    application: QueuedApplication,
    profile: MatchingProfile,
    roles: QueuedRole[],
    excluded: ReadonlySet<string>,
    completed: ReadonlyMap<string, number>,
  ): Promise<AutoAddPair[]> {
    const pairs: AutoAddPair[] = [];
    for (const role of roles) {
      for (const seat of await this.seatsOf(state, role.roleCode)) {
        if (state.gone.has(seat.seatId)) continue;
        if (!isPairAllowed(seat, application.userId, excluded)) continue;
        const evaluation = evaluatePair(
          seat,
          {
            userId: application.userId,
            level: levelInRole(profile.rolePrefs, role.roleCode),
            hoursPerWeek: profile.hoursPerWeek,
            timezone: profile.timezone,
            stack: profile.stack,
            completedInRole: completed.get(role.roleCode) ?? 0,
          },
          state.now,
        );
        if (!evaluation.eligible || evaluation.score < AUTO_ADD_THRESHOLD) continue;
        pairs.push({
          seatId: seat.seatId,
          teamId: seat.teamId,
          roleCode: role.roleCode,
          priority: role.priority,
          score: evaluation.score,
          openedAt: seat.openedAt,
          addedAt: role.addedAt,
        });
      }
    }
    return pairs;
  }

  /** One pair in its own transaction; a refusal is an outcome, not an error. */
  private async attempt(
    runId: string,
    application: QueuedApplication,
    pair: AutoAddPair,
  ): Promise<Attempt> {
    try {
      return await this.tx.run(() => this.pairInTx(runId, application, pair));
    } catch (error) {
      // A lost race that surfaced as an error (a unique index, a lock timeout) rolled the pair
      // back; the log row is written on its own.
      if (!(error instanceof DomainError)) throw error;
      const reason: string = error.code;
      await this.tx.run(() => this.log(runId, application.id, pair.seatId, 'skipped', reason));
      return SKIPS_APPLICATION.has(reason)
        ? { kind: 'skip-application', reason }
        : { kind: 'next-pair', reason };
    }
  }

  private async pairInTx(
    runId: string,
    application: QueuedApplication,
    pair: AutoAddPair,
  ): Promise<Attempt> {
    const skipped = async (
      reason: string,
      kind: 'next-pair' | 'skip-application',
    ): Promise<Attempt> => {
      await this.log(runId, application.id, pair.seatId, 'skipped', reason);
      return { kind, reason };
    };
    try {
      await this.auth.lockUserForJoin(application.userId); // lock #1
    } catch (error) {
      if (error instanceof DomainError && error.code === 'USER_INACTIVE') {
        return skipped('USER_INACTIVE', 'skip-application');
      }
      throw error;
    }
    await this.locks.lockSearchApplication(application.id); // lock #2
    const row = await this.applications.find(application.id);
    if (row === undefined || row.status !== 'active') {
      return skipped('APPLICATION_NOT_ACTIVE', 'skip-application');
    }
    const roles = await this.applications.listRoles(row.id);
    if (!roles.some((role) => role.isActive && role.roleCode === pair.roleCode)) {
      return skipped('ROLE_REMOVED', 'next-pair');
    }
    if (await this.queue.isExcluded(row.id, pair.teamId)) return skipped('EXCLUDED', 'next-pair');

    const joined = await this.teams.joinSeat({
      seatId: pair.seatId,
      userId: row.userId,
      via: 'auto',
      applicationId: row.id,
      userLocked: true,
    });
    if (!joined.ok) {
      const kind = SKIPS_APPLICATION.has(joined.code) ? 'skip-application' : 'next-pair';
      return skipped(joined.code, kind);
    }
    await this.fulfil(row, joined);
    await this.log(runId, row.id, pair.seatId, 'added', null);
    return { kind: 'added' };
  }

  /** The application is `fulfilled`, the wait is closed (FR-MATCH-10) and both sides are told. */
  private async fulfil(
    row: ApplicationRow,
    joined: Extract<JoinSeatResult, { ok: true }>,
  ): Promise<void> {
    const now = this.clock.now();
    const waited =
      Math.floor((now.getTime() - row.enqueuedAt.getTime()) / 1000) - row.pausedSeconds;
    await this.applications.update(row.id, {
      status: 'fulfilled',
      fulfilledAt: now,
      fulfilledSeatId: joined.seatId,
      fulfilledRoleCode: joined.roleCode,
      fulfilledTeamId: joined.teamId,
      version: row.version + 1,
    });
    await this.applications.deactivateRoles(row.id);
    await this.queue.insertWaitSample({
      id: uuidv7(),
      applicationId: row.id,
      roleCode: joined.roleCode,
      waitedSeconds: Math.max(0, waited),
      matchedAt: now,
    });
    await this.outbox.publishMany([
      matchingEvent('auto_added', row.id, {
        userId: row.userId,
        teamId: joined.teamId,
        seatId: joined.seatId,
        roleCode: joined.roleCode,
      }),
      applicationChanged({ userId: row.userId, applicationId: row.id, status: 'fulfilled' }),
    ]);
  }

  private log(
    runId: string,
    applicationId: string,
    seatId: string,
    outcome: 'added' | 'skipped',
    reason: string | null,
  ): Promise<void> {
    return this.queue.insertLog({
      id: uuidv7(),
      runId,
      applicationId,
      seatId,
      outcome,
      reason,
      at: this.clock.now(),
    });
  }
}
