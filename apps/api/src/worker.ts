import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { Logger } from 'nestjs-pino';
import { loadConfigOrExit } from './platform/config/config.js';
import { WorkerModule } from './worker.module.js';

/** Background entry point (process `worker`): application context without an HTTP server. */
async function bootstrap(): Promise<void> {
  const config = loadConfigOrExit(process.env, 'worker');
  const app = await NestFactory.createApplicationContext(WorkerModule.forRoot(config), {
    bufferLogs: true,
  });
  app.useLogger(app.get(Logger));
  app.enableShutdownHooks();
}

bootstrap().catch((error: unknown) => {
  process.stderr.write(
    `worker failed to start: ${error instanceof Error ? error.message : 'unknown error'}\n`,
  );
  process.exit(1);
});
