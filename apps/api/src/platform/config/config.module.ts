import { Global, Module, type DynamicModule } from '@nestjs/common';
import type { AppConfig } from './config.js';

/** Injection token for the validated, frozen configuration. */
export const APP_CONFIG = Symbol('APP_CONFIG');

@Global()
@Module({})
export class ConfigModule {
  static forRoot(config: AppConfig): DynamicModule {
    return {
      module: ConfigModule,
      providers: [{ provide: APP_CONFIG, useValue: config }],
      exports: [APP_CONFIG],
    };
  }
}
