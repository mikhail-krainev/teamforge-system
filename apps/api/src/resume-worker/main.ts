import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { Worker } from 'bullmq';
import { Redis } from 'ioredis';
import { type ParseOutcome, jobDataSchema } from './protocol.js';
import { type ChildOptions, runChild, selfCheckChild } from './run-child.js';

/** A resume is at most 5 MiB; the job carries it base64 encoded. */
const MAX_BYTES = 5 * 1024 * 1024;

const log = (message: string, fields: Record<string, unknown> = {}): void => {
  process.stdout.write(`${JSON.stringify({ level: 'info', msg: message, ...fields })}\n`);
};

/** The Redis URL comes from a Docker secret file (readable by the parent uid only) or the environment. */
function redisUrl(): string {
  const file = process.env.REDIS_RESUME_URL_FILE;
  const value = file ? readFileSync(file, 'utf8').trim() : process.env.REDIS_RESUME_URL;
  if (!value) throw new Error('REDIS_RESUME_URL or REDIS_RESUME_URL_FILE is required');
  return value;
}

function optionalId(name: string): number | undefined {
  const value = process.env[name];
  return value === undefined || value === '' ? undefined : Number(value);
}

function childOptions(): ChildOptions {
  const flags = process.env.RESUME_NODE_FLAGS;
  return {
    childPath: fileURLToPath(new URL('./child.js', import.meta.url)),
    uid: optionalId('RESUME_CHILD_UID'),
    gid: optionalId('RESUME_CHILD_GID'),
    nodeFlags: flags ? flags.split(' ').filter(Boolean) : undefined,
  };
}

async function handle(data: unknown, options: ChildOptions): Promise<ParseOutcome> {
  const job = jobDataSchema.safeParse(data);
  if (!job.success) return { v: 1, ok: false, reason: 'UNSUPPORTED' };
  const bytes = Buffer.from(job.data.data, 'base64');
  if (bytes.length > MAX_BYTES) return { v: 1, ok: false, reason: 'LIMIT' };
  const kind = job.data.mime === 'application/pdf' ? 'pdf' : 'docx';
  const outcome = await runChild(kind, bytes, options);
  log('resume parsed', { upload_id: job.data.uploadId, ok: outcome.ok });
  return outcome;
}

/**
 * Parent process of the resume sandbox (architecture 13.15). It only talks to `redis-resume`: it takes
 * a job, hands the bytes to a one-shot child under another uid and returns the child's checked
 * answer. The text of a resume is never written to a log.
 */
async function start(): Promise<void> {
  const options = childOptions();
  if (process.argv.includes('--selfcheck')) {
    process.stdout.write(await selfCheckChild(options));
    return;
  }
  const connection = new Redis(redisUrl(), { maxRetriesPerRequest: null });
  const worker = new Worker<unknown, ParseOutcome>(
    'resume-parse',
    (job) => handle(job.data, options),
    {
      connection,
      prefix: process.env.QUEUE_PREFIX ?? 'bull',
      concurrency: 2,
    },
  );
  worker.on('error', (error) => log('worker error', { error: error.message }));
  const stop = (): void => {
    void worker.close().then(() => connection.quit().then(() => process.exit(0)));
  };
  process.on('SIGTERM', stop);
  process.on('SIGINT', stop);
  log('resume-worker started');
}

start().catch((error: unknown) => {
  process.stderr.write(
    `resume-worker failed: ${error instanceof Error ? error.message : 'error'}\n`,
  );
  process.exit(1);
});
