import { CLI_JOB_NAMES, isCliJobName, type CliJobName } from '../platform/queues/cli-jobs.js';

export type RunJobArgs = { ok: true; job: CliJobName } | { ok: false; message: string };

/**
 * Arguments of `node dist/cli/run-job.js <job>`: exactly one name from the closed list. Anything
 * else (no name, an unknown name, extra arguments, an option) is refused before the application
 * starts, so nothing is connected and nothing runs.
 */
export function parseRunJobArgs(argv: readonly string[]): RunJobArgs {
  const usage = `usage: run-job <${CLI_JOB_NAMES.join('|')}>`;
  if (argv.length === 0) return { ok: false, message: `a job name is required; ${usage}` };
  if (argv.length > 1) return { ok: false, message: `exactly one job name is expected; ${usage}` };
  const [name = ''] = argv;
  if (!isCliJobName(name)) {
    return { ok: false, message: `unknown job "${name.slice(0, 64)}"; ${usage}` };
  }
  return { ok: true, job: name };
}
