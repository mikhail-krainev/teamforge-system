import { Global, Module } from '@nestjs/common';
import { MaintenanceTasks, RepeatingJobs } from './maintenance-tasks.js';
import { ProcessorRegistry } from './queue-workers.js';
import { QueuesService } from './queues.service.js';

@Global()
@Module({
  providers: [QueuesService, ProcessorRegistry, MaintenanceTasks, RepeatingJobs],
  exports: [QueuesService, ProcessorRegistry, MaintenanceTasks, RepeatingJobs],
})
export class QueuesModule {}
