import { Global, Module } from '@nestjs/common';
import { CliJobs } from './cli-jobs.js';
import { MaintenanceTasks, RepeatingJobs } from './maintenance-tasks.js';
import { ProcessorRegistry } from './queue-workers.js';
import { QueuesService } from './queues.service.js';
import { ResultListeners } from './result-listeners.js';

@Global()
@Module({
  providers: [
    CliJobs,
    QueuesService,
    ProcessorRegistry,
    ResultListeners,
    MaintenanceTasks,
    RepeatingJobs,
  ],
  exports: [
    CliJobs,
    QueuesService,
    ProcessorRegistry,
    ResultListeners,
    MaintenanceTasks,
    RepeatingJobs,
  ],
})
export class QueuesModule {}
