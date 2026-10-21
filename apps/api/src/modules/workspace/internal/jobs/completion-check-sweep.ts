import { Inject, Injectable, type OnModuleInit } from '@nestjs/common';
import { PinoLogger } from 'nestjs-pino';
import { Clock } from '../../../../platform/clock/clock.js';
import { MaintenanceTasks } from '../../../../platform/queues/maintenance-tasks.js';
import { TxRunner } from '../../../../platform/tx/tx-runner.js';
import { CompletionRepository } from '../repositories/completion.repository.js';
import {
  CHECK_GIVE_UP_AFTER_MS,
  CHECK_REQUEUE_AFTER_MS,
  CompletionCheckService,
} from '../services/completion-check.service.js';

const SWEEP_BATCH = 100;

/**
 * Repairs what the queue cannot promise (FR-WORK-13): a check whose job was lost with Redis is queued again
 * under a new id (one per window); one that is still not finished after half an hour is `failed`, and the
 * lead asks again. Applying the verdict twice changes nothing.
 */
@Injectable()
export class CompletionCheckSweep implements OnModuleInit {
  constructor(
    @Inject(MaintenanceTasks) private readonly maintenance: MaintenanceTasks,
    @Inject(TxRunner) private readonly tx: TxRunner,
    @Inject(Clock) private readonly clock: Clock,
    @Inject(CompletionRepository) private readonly completions: CompletionRepository,
    @Inject(CompletionCheckService) private readonly checks: CompletionCheckService,
    @Inject(PinoLogger) private readonly logger: PinoLogger,
  ) {}

  onModuleInit(): void {
    this.maintenance.register({
      name: 'completion-check-sweep',
      everyMs: CHECK_REQUEUE_AFTER_MS,
      run: () => this.sweep(),
    });
  }

  /** Returns the number of checks handled. */
  async sweep(): Promise<number> {
    const now = this.clock.now();
    const waiting = await this.tx.run(() =>
      this.completions.unfinishedBefore(
        new Date(now.getTime() - CHECK_REQUEUE_AFTER_MS),
        SWEEP_BATCH,
      ),
    );
    for (const check of waiting) {
      try {
        if (now.getTime() - check.requestedAt.getTime() >= CHECK_GIVE_UP_AFTER_MS) {
          await this.checks.fail(check.id);
        } else if (check.status === 'queued') {
          const round = Math.floor(now.getTime() / CHECK_REQUEUE_AFTER_MS);
          await this.checks.enqueue(check.id, round);
        }
      } catch (error) {
        this.logger.error({ err: error }, `completion-check-sweep failed for check ${check.id}`);
      }
    }
    return waiting.length;
  }
}
