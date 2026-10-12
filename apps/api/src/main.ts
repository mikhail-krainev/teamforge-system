import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { AppModule } from './app.module.js';
import { loadConfigOrExit } from './platform/config/config.js';
import { buildFastifyAdapter, configureHttpApp } from './platform/http/fastify.js';

/** HTTP entry point (process `api`). Configuration is validated before Nest is created. */
async function bootstrap(): Promise<void> {
  const config = loadConfigOrExit(process.env, 'api');
  const app = await NestFactory.create<NestFastifyApplication>(
    AppModule.forRoot(config),
    buildFastifyAdapter(config),
    { bufferLogs: true },
  );
  configureHttpApp(app);
  app.enableShutdownHooks();
  await app.listen(config.API_PORT, '0.0.0.0');
}

bootstrap().catch((error: unknown) => {
  process.stderr.write(
    `api failed to start: ${error instanceof Error ? error.message : 'unknown error'}\n`,
  );
  process.exit(1);
});
