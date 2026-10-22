import { Global, Inject, Injectable, Module, type OnApplicationShutdown } from '@nestjs/common';
import { TransactionHost } from '@nestjs-cls/transactional';
import { drizzle, type PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import { APP_CONFIG } from '../config/config.module.js';
import type { AppConfig } from '../config/config.js';
import { InvariantError } from '../errors/domain-error.js';

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

/** Methods of the client that start a statement on a pooled connection. */
const STATEMENT_METHODS: ReadonlySet<string | symbol> = new Set([
  'select',
  'selectDistinct',
  'selectDistinctOn',
  'insert',
  'update',
  'delete',
  'execute',
  'with',
  '$count',
]);

function transactionIsActive(): boolean {
  try {
    return TransactionHost.getInstance().isTransactionActive();
  } catch {
    // The transactional plugin is not registered (migrations, one-off scripts): nothing to guard.
    return false;
  }
}

/**
 * Development and test guard against pool starvation (architecture 12.1, B1): inside a transaction
 * the connection pool is shared with every other request, so a statement sent through the shared
 * client takes a SECOND connection. When as many transactions as the pool holds do this at once,
 * each waits for a connection that only another one can release and the process stops. The
 * statement methods of the shared client therefore throw while a transaction is active; code in
 * a transaction must use `TxRunner.tx`. Transactions themselves (`transaction`) are not affected.
 */
export function guardSharedClient(
  db: Database,
  isTransactionActive: () => boolean = transactionIsActive,
): Database {
  return new Proxy(db, {
    get(target, property) {
      const value: unknown = Reflect.get(target, property, target);
      if (typeof value !== 'function') return value;
      const method = value as (...args: unknown[]) => unknown;
      if (!STATEMENT_METHODS.has(property)) return method.bind(target);
      return (...args: unknown[]): unknown => {
        if (isTransactionActive()) {
          throw new InvariantError(
            `Shared database client used inside a transaction (${String(property)}): use TxRunner.tx, a second pool connection can starve the pool`,
          );
        }
        return method.apply(target, args);
      };
    },
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
      inject: [PG_CLIENT, APP_CONFIG],
      useFactory: (client: postgres.Sql, config: AppConfig): Database => {
        const db = drizzle(client);
        return config.NODE_ENV === 'production' ? db : guardSharedClient(db);
      },
    },
    PgLifecycle,
  ],
  exports: [DB, PG_CLIENT],
})
export class DbModule {}
