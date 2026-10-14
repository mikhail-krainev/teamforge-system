import { Inject, Injectable, type OnModuleInit } from '@nestjs/common';
import { MaintenanceTasks } from '../../../../platform/queues/maintenance-tasks.js';
import { VoteDeadlineService } from '../services/vote-deadline.service.js';

const MINUTE_MS = 60_000;

/**
 * `vote-deadline-scan` (every minute, architecture 8.3): the safety net for `vote-deadline` jobs
 * lost in Redis. It does not queue anything (a queued job with the same id may still sit in Redis
 * and block the new one): it moves each overdue vote on itself, through the same handler as the
 * job. Safe to run twice in a row and in parallel.
 */
@Injectable()
export class VoteDeadlineScan implements OnModuleInit {
  constructor(
    @Inject(MaintenanceTasks) private readonly maintenance: MaintenanceTasks,
    @Inject(VoteDeadlineService) private readonly deadlines: VoteDeadlineService,
  ) {}

  onModuleInit(): void {
    this.maintenance.register({
      name: 'vote-deadline-scan',
      everyMs: MINUTE_MS,
      run: () => this.deadlines.scan(),
    });
  }
}
