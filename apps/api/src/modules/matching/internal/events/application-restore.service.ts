import { Inject, Injectable } from '@nestjs/common';
import { Clock } from '../../../../platform/clock/clock.js';
import { DomainError } from '../../../../platform/errors/domain-error.js';
import { OutboxService } from '../../../../platform/outbox/outbox.service.js';
import { LockService } from '../../../../platform/tx/locks.js';
import { AUTH_API, type AuthApi } from '../../../auth/public.js';
import { ApplicationRepository } from '../repositories/application.repository.js';
import { applicationChanged } from '../services/matching-events.js';
import { RestoreRepository } from './restore.repository.js';

export interface Excluded {
  userId: string;
  applicationId: string;
  teamId: string;
}

/**
 * The person comes back to the queue after `teams.member_excluded` (FR-MATCH-08, architecture 6.5,
 * Р-15, ADR-0014). Runs in the transaction of the event handler: lock #1 (user) -> #2 (application),
 * the order of every other writer of the queue. Re-reading and reconciling makes a repeated delivery
 * harmless.
 *
 * - No active application: the fulfilled one becomes `active` again with the same `enqueued_at`,
 *   roles and priorities; the time in the team is added to `paused_seconds`; the team is remembered
 *   as an exclusion.
 * - A new active application exists: the old one stays as it is; the exclusions (this team and the
 *   old ones) and the earlier `enqueued_at` move to the new one.
 */
@Injectable()
export class ApplicationRestoreService {
  constructor(
    @Inject(Clock) private readonly clock: Clock,
    @Inject(LockService) private readonly locks: LockService,
    @Inject(OutboxService) private readonly outbox: OutboxService,
    @Inject(AUTH_API) private readonly auth: AuthApi,
    @Inject(ApplicationRepository) private readonly applications: ApplicationRepository,
    @Inject(RestoreRepository) private readonly restores: RestoreRepository,
  ) {}

  async restore(excluded: Excluded): Promise<void> {
    try {
      await this.auth.lockUserForJoin(excluded.userId); // lock #1
    } catch (error) {
      if (error instanceof DomainError && error.code === 'USER_INACTIVE') return;
      throw error;
    }
    const current = await this.applications.findActiveByUser(excluded.userId);
    if (current !== undefined && current.id !== excluded.applicationId) {
      await this.carryOver(excluded, current.id);
      return;
    }
    await this.reactivate(excluded);
  }

  /** The user stood in the queue again: the old application stays `fulfilled` (Р-15). */
  private async carryOver(excluded: Excluded, currentId: string): Promise<void> {
    await this.locks.lockSearchApplication(currentId); // lock #2
    const current = await this.applications.find(currentId);
    const old = await this.applications.find(excluded.applicationId);
    if (current === undefined || current.status !== 'active') return;
    if (old === undefined || old.userId !== excluded.userId) return;
    const teams = [...(await this.restores.exclusionsOf(old.id)), excluded.teamId];
    await this.restores.addExclusions(current.id, teams);
    if (old.enqueuedAt < current.enqueuedAt) {
      await this.applications.update(current.id, {
        enqueuedAt: old.enqueuedAt,
        version: current.version + 1,
      });
    }
    await this.publishActive(current.userId, current.id);
  }

  private async reactivate(excluded: Excluded): Promise<void> {
    await this.locks.lockSearchApplication(excluded.applicationId); // lock #2
    const row = await this.applications.find(excluded.applicationId);
    if (row === undefined || row.userId !== excluded.userId) return;
    if (row.status === 'active') {
      // Already restored by an earlier delivery of the same event.
      await this.restores.addExclusions(row.id, [excluded.teamId]);
      return;
    }
    // A cancelled application stays cancelled; one fulfilled by another team is a later join.
    if (row.status !== 'fulfilled' || row.fulfilledTeamId !== excluded.teamId) return;
    const now = this.clock.now();
    const inTeam =
      row.fulfilledAt === null ? 0 : Math.floor((now.getTime() - row.fulfilledAt.getTime()) / 1000);
    await this.applications.update(row.id, {
      status: 'active',
      pausedSeconds: row.pausedSeconds + Math.max(0, inTeam),
      fulfilledAt: null,
      fulfilledSeatId: null,
      fulfilledRoleCode: null,
      fulfilledTeamId: null,
      restoredAt: now,
      version: row.version + 1,
    });
    await this.restores.activateRoles(row.id);
    await this.restores.addExclusions(row.id, [excluded.teamId]);
    await this.publishActive(row.userId, row.id);
  }

  private async publishActive(userId: string, applicationId: string): Promise<void> {
    await this.outbox.publishMany([
      applicationChanged({ userId, applicationId, status: 'active' }),
    ]);
  }
}
