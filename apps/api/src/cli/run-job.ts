import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { ClsService } from 'nestjs-cls';
import { Logger } from 'nestjs-pino';
import { loadConfigOrExit } from '../platform/config/config.js';
import { CliJobs } from '../platform/queues/cli-jobs.js';
import { CliModule } from './cli.module.js';
import { parseRunJobArgs } from './run-job-args.js';

/**
 * One-off run of a background job: `docker compose exec worker node dist/cli/run-job.js <job>`.
 * The job list is closed (`CLI_JOB_NAMES`) and checked before anything is connected. The report of
 * the job is printed as one JSON line; the exit code is 0 on success, 2 for bad arguments, 1 otherwise.
 */
async function main(): Promise<void> {
  const parsed = parseRunJobArgs(process.argv.slice(2));
  if (!parsed.ok) {
    process.stderr.write(`${parsed.message}\n`);
    process.exit(2);
  }
  const config = loadConfigOrExit(process.env, 'worker');
  const app = await NestFactory.createApplicationContext(CliModule.forRoot(config), {
    bufferLogs: true,
  });
  app.useLogger(app.get(Logger));
  try {
    const run = app.get(CliJobs).get(parsed.job);
    if (run === undefined) throw new Error(`job ${parsed.job} is not registered`);
    const report = await app.get(ClsService).run(run);
    process.stdout.write(`${JSON.stringify(report)}\n`);
  } finally {
    await app.close();
  }
}

main().then(
  () => process.exit(0),
  (error: unknown) => {
    process.stderr.write(
      `run-job failed: ${error instanceof Error ? error.message : 'unknown error'}\n`,
    );
    process.exit(1);
  },
);
