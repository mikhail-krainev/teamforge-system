import { Global, Module } from '@nestjs/common';
import { ProcessorRegistry } from './queue-workers.js';
import { QueuesService } from './queues.service.js';

@Global()
@Module({
  providers: [QueuesService, ProcessorRegistry],
  exports: [QueuesService, ProcessorRegistry],
})
export class QueuesModule {}
