import { Inject, Injectable, type OnModuleInit } from '@nestjs/common';
import { Clock } from '../../../../platform/clock/clock.js';
import { MaintenanceTasks } from '../../../../platform/queues/maintenance-tasks.js';
import { TxRunner } from '../../../../platform/tx/tx-runner.js';
import { INVITATION_RETENTION_MS } from '../domain/invitation-rules.js';
import { InvitationRepository } from '../repositories/invitation.repository.js';

const HOUR_MS = 60 * 60 * 1000;

/**
 * `invitation-cleanup` (maintenance queue, hourly): overdue `active` invitations become `expired`,
 * and used, revoked and expired rows older than 30 days are deleted (architecture 3.4, C-12).
 * Safe to run twice in a row.
 */
@Injectable()
export class InvitationCleanup implements OnModuleInit {
  constructor(
    @Inject(MaintenanceTasks) private readonly maintenance: MaintenanceTasks,
    @Inject(TxRunner) private readonly tx: TxRunner,
    @Inject(Clock) private readonly clock: Clock,
    @Inject(InvitationRepository) private readonly invitations: InvitationRepository,
  ) {}

  onModuleInit(): void {
    this.maintenance.register({
      name: 'invitation-cleanup',
      everyMs: HOUR_MS,
      run: () => this.run(),
    });
  }

  /** Returns the number of rows deleted. */
  run(): Promise<number> {
    return this.tx.run(async () => {
      const now = this.clock.now();
      await this.invitations.expireAllOverdue(now);
      return this.invitations.deleteFinishedBefore(
        new Date(now.getTime() - INVITATION_RETENTION_MS),
      );
    });
  }
}
