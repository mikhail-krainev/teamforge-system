import { Inject, Injectable } from '@nestjs/common';
import { uuidv7 } from 'uuidv7';
import type { Body } from 'shared';
import { Clock } from '../../../../platform/clock/clock.js';
import { DomainError } from '../../../../platform/errors/domain-error.js';
import { OutboxService } from '../../../../platform/outbox/outbox.service.js';
import { LockService } from '../../../../platform/tx/locks.js';
import { TxRunner } from '../../../../platform/tx/tx-runner.js';
import { AUTH_API, type AuthApi } from '../../../auth/public.js';
import { PROFILES_API, type ProfilesApi } from '../../../profiles/public.js';
import { diffRoles, roleErrors, type RoleInput } from '../domain/application-rules.js';
import {
  ApplicationRepository,
  type ApplicationRow,
} from '../repositories/application.repository.js';
import { type ApplicationDto, toApplicationDto } from './application-dto.js';
import { applicationChanged } from './matching-events.js';

type CreateBody = Body<'createSearchApplication'>;
type UpdateBody = Body<'updateSearchApplication'>;

/** Thrown inside the transaction when the caller's `version` is stale; turned into 409 outside it. */
class VersionConflict extends Error {
  constructor() {
    super('version conflict');
    this.name = 'VersionConflict';
  }
}

/**
 * The search queue application of the signed-in user (FR-MATCH-03, FR-MATCH-04, CC-10).
 * Mutations take lock #1 (the user) and then lock #2 (the application) and run in one transaction.
 */
@Injectable()
export class ApplicationService {
  constructor(
    @Inject(TxRunner) private readonly tx: TxRunner,
    @Inject(Clock) private readonly clock: Clock,
    @Inject(OutboxService) private readonly outbox: OutboxService,
    @Inject(LockService) private readonly locks: LockService,
    @Inject(AUTH_API) private readonly auth: AuthApi,
    @Inject(PROFILES_API) private readonly profiles: ProfilesApi,
    @Inject(ApplicationRepository) private readonly applications: ApplicationRepository,
  ) {}

  /** The active application; 404 when the user is not in the queue. */
  async getMine(userId: string): Promise<ApplicationDto> {
    const row = await this.applications.findActiveByUser(userId);
    if (row === undefined) throw new DomainError('APPLICATION_NOT_FOUND', 404);
    return toApplicationDto(row, await this.applications.listRoles(row.id));
  }

  async create(userId: string, body: CreateBody): Promise<ApplicationDto> {
    await this.checkRoles(body.roles);
    return this.tx.run(() => this.createInTx(userId, body));
  }

  private async createInTx(userId: string, body: CreateBody): Promise<ApplicationDto> {
    const eligibility = await this.auth.lockUserForJoin(userId);
    if (eligibility.githubUserId === null) throw new DomainError('GITHUB_REQUIRED', 409);
    if (!eligibility.consentValid) throw new DomainError('CONSENT_REQUIRED', 403);
    // Lock #1 serializes the user's own requests; `search_application_active_uq` is the final guard.
    if ((await this.applications.findActiveByUser(userId)) !== undefined) {
      throw new DomainError('APPLICATION_EXISTS', 409);
    }
    const now = this.clock.now();
    const row = {
      id: uuidv7(),
      userId,
      status: 'active',
      enqueuedAt: now,
      pausedSeconds: 0,
      version: 1,
    };
    const roles = body.roles.map((role) => ({
      applicationId: row.id,
      roleCode: role.roleCode,
      priority: role.priority,
      addedAt: now,
      isActive: true,
    }));
    await this.applications.insert(row, roles);
    await this.outbox.publishMany([
      applicationChanged({ userId, applicationId: row.id, status: 'active' }),
    ]);
    return toApplicationDto({ ...row, ...emptyApplication }, roles);
  }

  async update(userId: string, body: UpdateBody): Promise<ApplicationDto> {
    await this.checkRoles(body.roles);
    let id: string;
    try {
      id = await this.tx.run(() => this.updateInTx(userId, body));
    } catch (error) {
      if (!(error instanceof VersionConflict)) throw error;
      const current = await this.getMine(userId);
      throw new DomainError('VERSION_CONFLICT', 409, { current: { ...current } });
    }
    const row = await this.applications.find(id);
    if (row === undefined) throw new DomainError('APPLICATION_NOT_FOUND', 404);
    return toApplicationDto(row, await this.applications.listRoles(id));
  }

  /** Returns the id of the application; an unchanged set of roles writes nothing (no new version). */
  private async updateInTx(userId: string, body: UpdateBody): Promise<string> {
    const row = await this.lockActive(userId);
    if (row.version !== body.version) throw new VersionConflict();
    const stored = await this.applications.listRoles(row.id);
    const change = diffRoles(stored, body.roles);
    if (!change.changed) return row.id;
    const now = this.clock.now();
    await this.applications.deleteRoles(row.id, change.removed);
    for (const role of change.reprioritized) {
      await this.applications.setPriority(row.id, role.roleCode, role.priority);
    }
    await this.applications.insertRoles(
      change.added.map((role) => ({
        applicationId: row.id,
        roleCode: role.roleCode,
        priority: role.priority,
        addedAt: now,
        isActive: true,
      })),
    );
    await this.applications.update(row.id, { version: row.version + 1 });
    await this.outbox.publishMany([
      applicationChanged({ userId, applicationId: row.id, status: 'active' }),
    ]);
    return row.id;
  }

  async cancel(userId: string): Promise<void> {
    await this.tx.run(() => this.cancelInTx(userId));
  }

  private async cancelInTx(userId: string): Promise<void> {
    const row = await this.lockActive(userId);
    await this.applications.update(row.id, {
      status: 'cancelled',
      cancelledAt: this.clock.now(),
      version: row.version + 1,
    });
    await this.applications.deactivateRoles(row.id);
    await this.outbox.publishMany([
      applicationChanged({ userId, applicationId: row.id, status: 'cancelled' }),
    ]);
  }

  /**
   * Lock #1 (user) -> #2 (application). The application is found under lock #1 and read again
   * under lock #2: an auto-add (T2, same order) that won the race has already made it `fulfilled`.
   */
  private async lockActive(userId: string): Promise<ApplicationRow> {
    await this.auth.lockUserForJoin(userId);
    const found = await this.applications.findActiveByUser(userId);
    if (found === undefined) throw new DomainError('APPLICATION_NOT_FOUND', 404);
    await this.locks.lockSearchApplication(found.id);
    const row = await this.applications.find(found.id);
    if (row === undefined || row.status !== 'active')
      throw new DomainError('APPLICATION_NOT_FOUND', 404);
    return row;
  }

  /** 422: repeated role or priority, unknown or retired role. Reference data, checked before BEGIN. */
  private async checkRoles(roles: readonly RoleInput[]): Promise<void> {
    const errors = roleErrors(roles);
    if (errors.length > 0) throw new DomainError('VALIDATION_FAILED', 422, { errors });
    await this.profiles.assertRolesExist(
      roles.map((role) => role.roleCode),
      { activeOnly: true },
    );
  }
}

/** Columns a fresh application leaves at their defaults. */
const emptyApplication = {
  fulfilledAt: null,
  fulfilledSeatId: null,
  fulfilledRoleCode: null,
  fulfilledTeamId: null,
  cancelledAt: null,
  restoredAt: null,
};
