import { Inject, Injectable, type OnModuleInit } from '@nestjs/common';
import { PinoLogger } from 'nestjs-pino';
import { CliJobs } from '../../../../platform/queues/cli-jobs.js';
import { RepeatingJobs } from '../../../../platform/queues/maintenance-tasks.js';
import { type JobProcessor, ProcessorRegistry } from '../../../../platform/queues/queue-workers.js';
import { AUTO_ADD_WINDOW_MS } from '../domain/auto-add-rules.js';
import { AutoAddService } from '../services/auto-add.service.js';
import {
  AUTO_ADD_JOB,
  AUTO_ADD_QUEUE,
  AUTO_ADD_SCHEDULER_KEY,
} from '../services/auto-add-scheduler.service.js';

/**
 * Processor of the `matching-auto-add` queue (architecture 6.4, 13.12): every job, scheduled or
 * triggered by an event, is one run of `AutoAddService`. The repeating job is registered with a
 * fixed scheduler key, so starting several processes makes one schedule.
 */
@Injectable()
export class AutoAddProcessor implements JobProcessor, OnModuleInit {
  readonly queue = AUTO_ADD_QUEUE;

  constructor(
    @Inject(ProcessorRegistry) private readonly registry: ProcessorRegistry,
    @Inject(RepeatingJobs) private readonly repeating: RepeatingJobs,
    @Inject(CliJobs) private readonly cliJobs: CliJobs,
    @Inject(AutoAddService) private readonly autoAdd: AutoAddService,
    @Inject(PinoLogger) private readonly logger: PinoLogger,
  ) {}

  onModuleInit(): void {
    this.registry.register(this);
    // `run-job matching-auto-add`: one run now, for operators and the e2e stack (no HTTP door).
    this.cliJobs.register(AUTO_ADD_JOB, () => this.autoAdd.run());
    // The worker upserts the schedule at start; the API process must not wait for Redis at boot.
    this.repeating.register({
      queue: AUTO_ADD_QUEUE,
      key: AUTO_ADD_SCHEDULER_KEY,
      jobName: AUTO_ADD_JOB,
      everyMs: AUTO_ADD_WINDOW_MS,
    });
  }

  async process(): Promise<number> {
    const report = await this.autoAdd.run();
    this.logger.info({ ...report }, 'matching auto-add run done');
    return report.added;
  }
}
