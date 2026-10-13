import { Global, Module } from '@nestjs/common';
import { MaintenanceTasks } from './maintenance-tasks.js';
import { ProcessorRegistry } from './queue-workers.js';
import { QueuesService } from './queues.service.js';

@Global()
@Module({
  providers: [QueuesService, ProcessorRegistry, MaintenanceTasks],
  exports: [QueuesService, ProcessorRegistry, MaintenanceTasks],
})
export class QueuesModule {}
