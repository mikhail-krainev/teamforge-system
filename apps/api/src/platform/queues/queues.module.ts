import { Global, Module } from '@nestjs/common';
import { CliJobs } from './cli-jobs.js';
import { MaintenanceTasks, RepeatingJobs } from './maintenance-tasks.js';
import { ProcessorRegistry } from './queue-workers.js';
import { QueuesService } from './queues.service.js';

@Global()
@Module({
  providers: [CliJobs, QueuesService, ProcessorRegistry, MaintenanceTasks, RepeatingJobs],
  exports: [CliJobs, QueuesService, ProcessorRegistry, MaintenanceTasks, RepeatingJobs],
})
export class QueuesModule {}
