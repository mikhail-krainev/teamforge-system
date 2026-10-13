import { Inject, Injectable } from '@nestjs/common';
import { uuidv7 } from 'uuidv7';
import type { Body } from 'shared';
import { Clock } from '../../../../platform/clock/clock.js';
import { DomainError } from '../../../../platform/errors/domain-error.js';
import { OutboxService } from '../../../../platform/outbox/outbox.service.js';
import { TxRunner } from '../../../../platform/tx/tx-runner.js';
import { AUTH_API, type AuthApi } from '../../../auth/public.js';
import { PLAYBOOKS_API, type PlaybooksApi } from '../../../playbooks/public.js';
import {
  MAX_ACTIVE_PROJECTS,
  assignOrdinals,
  changedTeamFields,
  expandSeats,
  seatLimitError,
} from '../domain/team-rules.js';
import { SeatRepository } from '../repositories/seat.repository.js';
import { TeamEventRepository } from '../repositories/team-event.repository.js';
import { TeamRepository } from '../repositories/team.repository.js';
import { SeatCatalogCheck } from './seat-catalog-check.js';
import type { TeamDto } from './team-dto.js';
import { journalRow, teamsEvent } from './team-events.js';
import { TeamLeadLock, VersionConflict } from './team-lead-lock.js';
import { TeamViewService } from './team-view.service.js';

type CreateBody = Body<'createTeam'>;
type PatchBody = Body<'updateTeam'>;

function invalid(pointer: string, code: string, message: string): DomainError {
  return new DomainError('VALIDATION_FAILED', 422, { errors: [{ pointer, code, message }] });
}

/** createTeam (T3, FR-TEAM-01, FR-AUTH-05, CC-2) and updateTeam (FR-TEAM-01). */
@Injectable()
export class TeamService {
  constructor(
    @Inject(TxRunner) private readonly tx: TxRunner,
    @Inject(Clock) private readonly clock: Clock,
    @Inject(OutboxService) private readonly outbox: OutboxService,
    @Inject(AUTH_API) private readonly auth: AuthApi,
    @Inject(PLAYBOOKS_API) private readonly playbooks: PlaybooksApi,
    @Inject(TeamRepository) private readonly teams: TeamRepository,
    @Inject(SeatRepository) private readonly seats: SeatRepository,
    @Inject(TeamEventRepository) private readonly events: TeamEventRepository,
    @Inject(TeamLeadLock) private readonly leadLock: TeamLeadLock,
    @Inject(SeatCatalogCheck) private readonly catalog: SeatCatalogCheck,
    @Inject(TeamViewService) private readonly view: TeamViewService,
  ) {}

  /**
   * T3: lock #1 (the creator) serializes every create and join of one user; the project limit is
   * counted under that lock, so parallel creates cannot exceed C-10. Reads of reference data
   * (catalogs, the pinned playbook, the time zone) happen before BEGIN.
   */
  async create(userId: string, body: CreateBody): Promise<{ team: TeamDto; teamId: string }> {
    const specs = expandSeats(body.seats ?? []);
    const limit = seatLimitError(0, specs.length);
    if (limit !== undefined) throw new DomainError('SEAT_LIMIT', 422, { errors: [limit] });
    await this.assertTimezone(body.timezone);
    await this.catalog.check(body.seats ?? []);
    const playbookId = await this.pinPlaybook(body.productTypeCode);
    const teamId = uuidv7();
    await this.tx.run(() => this.createInTx(userId, teamId, playbookId, body));
    return { teamId, team: await this.view.team(teamId, userId) };
  }

  private async createInTx(
    userId: string,
    teamId: string,
    playbookId: string,
    body: CreateBody,
  ): Promise<void> {
    const eligibility = await this.auth.lockUserForJoin(userId);
    if (eligibility.githubUserId === null) throw new DomainError('GITHUB_REQUIRED', 409);
    if (!eligibility.consentValid) throw new DomainError('CONSENT_REQUIRED', 403);
    if ((await this.teams.countActiveProjects(userId)) >= MAX_ACTIVE_PROJECTS) {
      throw new DomainError('PROJECT_LIMIT', 409);
    }
    const now = this.clock.now();
    const specs = expandSeats(body.seats ?? []);
    await this.teams.insertTeam({
      id: teamId,
      name: body.name,
      description: body.description,
      productTypeCode: body.productTypeCode,
      playbookId,
      leadUserId: userId,
      status: 'forming',
      timezone: body.timezone,
      hoursPerWeek: body.hoursPerWeek,
      memberCount: 1,
      seatCount: specs.length,
      leadLastActiveAt: now,
      createdBy: userId,
      createdAt: now,
      updatedAt: now,
    });
    await this.teams.insertMembership({
      id: uuidv7(),
      teamId,
      userId,
      status: 'active',
      joinedVia: 'creator',
      joinedAt: now,
    });
    await this.openSeats(teamId, userId, specs, now);
    await this.events.insertMany([
      journalRow(teamId, 'team_created', userId, { productTypeCode: body.productTypeCode }, now),
    ]);
    await this.outbox.publishMany([
      teamsEvent('team_created', teamId, { teamId, leadUserId: userId }),
    ]);
  }

  /** Inserts the initial seats with their journal rows and `seat_opened` events (one statement each). */
  private async openSeats(
    teamId: string,
    userId: string,
    specs: ReturnType<typeof expandSeats>,
    now: Date,
  ): Promise<void> {
    const ordinals = assignOrdinals(specs, new Map());
    const rows = specs.map((spec, index) => ({
      id: uuidv7(),
      teamId,
      ...spec,
      ordinal: ordinals[index] ?? 1,
      desiredChangedAt: spec.desired ? now : null,
      status: 'open',
      openedAt: now,
    }));
    await this.seats.insertMany(rows);
    await this.events.insertMany(
      rows.map((s) =>
        journalRow(
          teamId,
          'seat_opened',
          userId,
          { seatId: s.id, roleCode: s.roleCode, desired: s.desired },
          now,
        ),
      ),
    );
    await this.outbox.publishMany(
      rows.map((s) =>
        teamsEvent('seat_opened', s.id, {
          seatId: s.id,
          teamId,
          roleCode: s.roleCode,
          openedAt: now.toISOString(),
        }),
      ),
    );
  }

  /** Optimistic update of the card by `version` under lock #4 (409 VERSION_CONFLICT with `current`). */
  async update(userId: string, teamId: string, body: PatchBody): Promise<TeamDto> {
    if (body.timezone !== undefined) await this.assertTimezone(body.timezone);
    try {
      await this.tx.run(() => this.updateInTx(userId, teamId, body));
    } catch (error) {
      if (!(error instanceof VersionConflict)) throw error;
      const current = await this.view.team(teamId, userId);
      throw new DomainError('VERSION_CONFLICT', 409, { current: { ...current } });
    }
    return this.view.team(teamId, userId);
  }

  private async updateInTx(userId: string, teamId: string, body: PatchBody): Promise<void> {
    const locked = await this.leadLock.lock(teamId, userId);
    if (locked.version !== body.version) throw new VersionConflict();
    const row = await this.teams.find(teamId);
    if (row === undefined) throw new DomainError('NOT_FOUND', 404);
    const changed = changedTeamFields(row, body);
    if (changed.length === 0) return;
    const now = this.clock.now();
    await this.teams.update(teamId, {
      ...(body.name === undefined ? {} : { name: body.name }),
      ...(body.description === undefined ? {} : { description: body.description }),
      ...(body.timezone === undefined ? {} : { timezone: body.timezone }),
      ...(body.hoursPerWeek === undefined ? {} : { hoursPerWeek: body.hoursPerWeek }),
      version: row.version + 1,
      updatedAt: now,
    });
    await this.events.insertMany([
      journalRow(teamId, 'team_updated', userId, { fields: changed }, now),
    ]);
  }

  private async assertTimezone(name: string): Promise<void> {
    if (!(await this.teams.isKnownTimezone(name))) {
      throw invalid('/timezone', 'unknown_timezone', 'Not an IANA time zone');
    }
  }

  /** FR-PLAY-06 / FR-PLAY-03: an active product type with a published playbook; its version is pinned. */
  private async pinPlaybook(productTypeCode: string): Promise<string> {
    const types = await this.playbooks.listProductTypes();
    const found = types.find((type) => type.code === productTypeCode);
    if (found === undefined) {
      throw invalid('/productTypeCode', 'unknown_product_type', 'Unknown product type');
    }
    if (!found.active) {
      throw invalid('/productTypeCode', 'inactive_product_type', 'Product type is not available');
    }
    const published = await this.playbooks.getLatestPublished(productTypeCode);
    if (published === null) {
      throw invalid('/productTypeCode', 'no_published_playbook', 'No published playbook');
    }
    return published.id;
  }
}
