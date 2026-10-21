import { Injectable } from '@nestjs/common';

/**
 * Jobs the operator CLI (`src/cli/run-job.ts`) may run once by hand. A closed list: the CLI refuses
 * every other name before it opens a connection, so it cannot be used to start arbitrary code.
 */
export const CLI_JOB_NAMES = ['matching-auto-add', 'rewards-cooling-end', 'review-publish'] as const;
export type CliJobName = (typeof CLI_JOB_NAMES)[number];

export function isCliJobName(value: string): value is CliJobName {
  return (CLI_JOB_NAMES as readonly string[]).includes(value);
}

/** What a one-off run answers with: a JSON-serializable report that the CLI prints. */
export type CliJobRunner = () => Promise<unknown>;

/** Registry that modules fill in `onModuleInit`; only the CLI process reads it. Nothing here is reachable over HTTP. */
@Injectable()
export class CliJobs {
  private readonly runners = new Map<CliJobName, CliJobRunner>();

  register(name: CliJobName, run: CliJobRunner): void {
    if (this.runners.has(name)) throw new Error(`CLI job ${name} already exists`);
    this.runners.set(name, run);
  }

  get(name: CliJobName): CliJobRunner | undefined {
    return this.runners.get(name);
  }
}
