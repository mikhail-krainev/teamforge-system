import { Inject, Injectable, type OnModuleInit } from '@nestjs/common';
import { CliJobs } from '../../../../platform/queues/cli-jobs.js';
import { MaintenanceTasks, TimerHandlers } from '../../../../platform/queues/maintenance-tasks.js';
import { DAY_MS, HOUR_MS, SCAN_AGE_MS } from '../domain/constants.js';
import { COOLING_END_JOB } from '../services/credit-run.service.js';
import { CreditRunScan } from '../services/credit-run-scan.service.js';
import { CreditService } from '../services/credit.service.js';
import { PendingRecheckService } from '../services/pending-recheck.service.js';

/** Reads `{ teamId }` of a `rewards-cooling-end` job. */
export function parseCoolingEnd(data: Record<string, unknown>): string {
  const { teamId } = data;
  if (typeof teamId !== 'string') throw new Error('rewards-cooling-end needs a teamId');
  return teamId;
}

/** M-6: the sweep that credits the runs whose cooling is over and whose timer was lost. */
export const CREDIT_DUE_SWEEP = 'credit-due-sweep';

/**
 * What rewards registers in the queues (architecture 10.1, 13.12): the timer `rewards-cooling-end` of `timers`
 * (`creditProject`), the scanners `credit-run-scan` (every 10 minutes), `credit-due-sweep` (hourly, M-6: the same
 * code as the timer for every run in the cooling whose time is over) and `pending-account-recheck` (daily) of
 * `maintenance`, and the CLI sweep of the same name as the timer for operators and the e2e stack.
 */
@Injectable()
export class RewardsJobs implements OnModuleInit {
  constructor(
    @Inject(TimerHandlers) private readonly timers: TimerHandlers,
    @Inject(MaintenanceTasks) private readonly maintenance: MaintenanceTasks,
    @Inject(CliJobs) private readonly cli: CliJobs,
    @Inject(CreditService) private readonly credit: CreditService,
    @Inject(CreditRunScan) private readonly scan: CreditRunScan,
    @Inject(PendingRecheckService) private readonly recheck: PendingRecheckService,
  ) {}

  onModuleInit(): void {
    this.timers.register(COOLING_END_JOB, (data) =>
      this.credit.creditProject(parseCoolingEnd(data)),
    );
    this.maintenance.register({
      name: 'credit-run-scan',
      everyMs: SCAN_AGE_MS,
      run: () => this.scan.scan(),
    });
    this.maintenance.register({
      name: CREDIT_DUE_SWEEP,
      everyMs: HOUR_MS,
      run: async () => {
        const report = await this.credit.creditDue();
        return report.credited + report.frozen;
      },
    });
    this.maintenance.register({
      name: 'pending-account-recheck',
      everyMs: DAY_MS,
      run: () => this.recheck.run(),
    });
    this.cli.register(COOLING_END_JOB, () => this.credit.creditDue());
  }
}
