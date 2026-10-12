import { type DynamicModule, Module } from '@nestjs/common';
import { DOMAIN_MODULES, type AppOptions } from './app.module.js';
import type { AppConfig } from './platform/config/config.js';
import { EventsProcessor } from './platform/outbox/events.processor.js';
import { MaintenanceProcessor } from './platform/outbox/maintenance.processor.js';
import { OutboxRelayLoop } from './platform/outbox/outbox-relay-loop.js';
import { PlatformModule } from './platform/platform.module.js';
import { QueueWorkers } from './platform/queues/queue-workers.js';

/** Background application (process `worker`): BullMQ processors, outbox relay, schedulers. */
@Module({})
export class WorkerModule {
  static forRoot(config: AppConfig, options: AppOptions = {}): DynamicModule {
    return {
      module: WorkerModule,
      imports: [PlatformModule.forRoot(config, { http: false, ...options }), ...DOMAIN_MODULES],
      providers: [EventsProcessor, MaintenanceProcessor, QueueWorkers, OutboxRelayLoop],
    };
  }
}
