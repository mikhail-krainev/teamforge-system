import { Global, Inject, Injectable, Module, type OnApplicationShutdown } from '@nestjs/common';
import { drizzle, type PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import { APP_CONFIG } from '../config/config.module.js';
import type { AppConfig } from '../config/config.js';

export type Database = PostgresJsDatabase;

export const DB = Symbol('DB');
export const PG_CLIENT = Symbol('PG_CLIENT');

/**
 * Creates the postgres-js client for PgBouncer in transaction mode: no named prepared statements
 * (`prepare: false`), state only through SET LOCAL (architecture 12.1).
 */
export function createPgClient(url: string, max: number, applicationName: string): postgres.Sql {
  return postgres(url, {
    prepare: false,
    max,
    idle_timeout: 30,
    connect_timeout: 10,
    onnotice: () => undefined,
    connection: { application_name: applicationName },
  });
}

@Injectable()
class PgLifecycle implements OnApplicationShutdown {
  constructor(@Inject(PG_CLIENT) private readonly client: postgres.Sql) {}

  async onApplicationShutdown(): Promise<void> {
    await this.client.end({ timeout: 5 });
  }
}

@Global()
@Module({
  providers: [
    {
      provide: PG_CLIENT,
      inject: [APP_CONFIG],
      useFactory: (config: AppConfig) =>
        createPgClient(config.DATABASE_URL, config.DATABASE_POOL_MAX, `teamforge-${config.role}`),
    },
    {
      provide: DB,
      inject: [PG_CLIENT],
      useFactory: (client: postgres.Sql): Database => drizzle(client),
    },
    PgLifecycle,
  ],
  exports: [DB, PG_CLIENT],
})
export class DbModule {}
