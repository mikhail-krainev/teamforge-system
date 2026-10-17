import { type DynamicModule, Module } from '@nestjs/common';
import { DOMAIN_MODULES } from '../app.module.js';
import type { AppConfig } from '../platform/config/config.js';
import { PlatformModule } from '../platform/platform.module.js';

/**
 * Application of the one-off job CLI (process `run-job`): platform and domain modules without HTTP,
 * `QueueWorkers`, the outbox relay and the schedulers of `WorkerModule`, so starting it processes
 * nothing by itself.
 */
@Module({})
export class CliModule {
  static forRoot(config: AppConfig): DynamicModule {
    return {
      module: CliModule,
      imports: [PlatformModule.forRoot(config, { http: false }), ...DOMAIN_MODULES],
    };
  }
}
