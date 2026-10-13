import { Inject, Injectable, type OnModuleInit } from '@nestjs/common';
import { eq } from 'drizzle-orm';
import { PinoLogger } from 'nestjs-pino';
import { Clock } from '../../../../platform/clock/clock.js';
import { jobId } from '../../../../platform/queues/job-id.js';
import { MaintenanceTasks } from '../../../../platform/queues/maintenance-tasks.js';
import { type JobProcessor, ProcessorRegistry } from '../../../../platform/queues/queue-workers.js';
import { QueuesService, type QueueJob } from '../../../../platform/queues/queues.service.js';
import { TxRunner } from '../../../../platform/tx/tx-runner.js';
import { stackTag } from '../schema/profiles.js';
import { contractFailure, type ParseResult } from './parse-result.js';
import { ResumeParseClient } from './resume-parse.client.js';
import { ResumeStorage } from './resume-storage.js';
import { suggestStack } from './resume-suggestions.js';
import { ResumeRepository, type Outcome } from './resume.repository.js';
import { ResumeService } from './resume.service.js';

const STUCK_AFTER_MS = 2 * 60_000;
const STUCK_BATCH = 100;

/**
 * Worker side of resume parsing (architecture 13.15): `resume-dispatch` reads the file from storage,
 * lets the isolated parser read it, and stores the checked outcome. `resume-stuck-scan` re-queues
 * uploads that never finished. The resume text is data: it is stored, never logged.
 */
@Injectable()
export class ResumePipeline implements JobProcessor, OnModuleInit {
  readonly queue = 'resume-dispatch' as const;

  constructor(
    @Inject(ProcessorRegistry) private readonly registry: ProcessorRegistry,
    @Inject(MaintenanceTasks) private readonly maintenance: MaintenanceTasks,
    @Inject(ResumeRepository) private readonly repository: ResumeRepository,
    @Inject(ResumeStorage) private readonly storage: ResumeStorage,
    @Inject(ResumeParseClient) private readonly parser: ResumeParseClient,
    @Inject(ResumeService) private readonly resumes: ResumeService,
    @Inject(QueuesService) private readonly queues: QueuesService,
    @Inject(TxRunner) private readonly tx: TxRunner,
    @Inject(Clock) private readonly clock: Clock,
    @Inject(PinoLogger) private readonly logger: PinoLogger,
  ) {}

  onModuleInit(): void {
    this.registry.register(this);
    this.maintenance.register({
      name: 'resume-stuck-scan',
      everyMs: STUCK_AFTER_MS,
      run: () => this.requeueStuck(),
    });
  }

  async process(job: QueueJob): Promise<void> {
    const uploadId = String(job.data.uploadId ?? '');
    const row = await this.tx.run(async () => {
      const found = await this.repository.findById(uploadId);
      if (found === undefined || found.storageKey === null) return undefined;
      return (await this.repository.markProcessing(uploadId)) ? found : undefined;
    });
    if (row?.storageKey == null) return;
    const bytes = await this.storage.read(row.storageKey);
    const result: ParseResult =
      bytes === null
        ? { v: 1, ok: false, reason: 'CORRUPTED' }
        : await this.parser.parse(uploadId, row.mime, bytes);
    await this.store(row.userId, uploadId, result);
  }

  /** The strict result becomes a row update; a deleted upload is skipped silently. */
  private async store(userId: string, uploadId: string, result: ParseResult): Promise<void> {
    await this.tx.run(async () => {
      const outcome = await this.outcomeOf(result);
      const row = await this.repository.finish(uploadId, outcome);
      if (row !== undefined) await this.resumes.publishUpdated(userId, uploadId, row.status);
    });
    this.logger.info({ upload_id: uploadId, ok: result.ok }, 'resume parsed');
  }

  private async outcomeOf(result: ParseResult): Promise<Outcome> {
    const at = this.clock.now();
    if (!result.ok) return { at, failure: contractFailure(result.reason) };
    const tags = await this.tx.tx
      .select({ code: stackTag.code })
      .from(stackTag)
      .where(eq(stackTag.active, true));
    const stack = suggestStack(
      result.text,
      tags.map((tag) => tag.code),
    );
    return { at, text: result.text, suggestions: stack.length > 0 ? { stack } : {} };
  }

  /**
   * The last attempt threw. A damaged file never gets here: it comes back from the parser as a
   * `CORRUPTED` result and is stored by `process`. A throw means the infrastructure failed (storage,
   * Redis, parser unreachable), so the user is told to try again later (`timeout`), not that the
   * file is broken (S2CR-06).
   */
  async onExhausted(job: QueueJob, error?: Error): Promise<void> {
    const uploadId = String(job.data.uploadId ?? '');
    this.logger.error({ upload_id: uploadId, err: error }, 'resume parsing attempts exhausted');
    await this.tx.run(async () => {
      const row = await this.repository.finish(uploadId, {
        at: this.clock.now(),
        failure: 'timeout',
      });
      if (row !== undefined) await this.resumes.publishUpdated(row.userId, uploadId, row.status);
    });
  }

  /** `resume-stuck-scan`: uploads older than 2 minutes that are still queued or processing. */
  async requeueStuck(): Promise<number> {
    const now = this.clock.now().getTime();
    const ids = await this.tx.run(() =>
      this.repository.stuckBefore(new Date(now - STUCK_AFTER_MS), STUCK_BATCH),
    );
    const bucket = Math.floor(now / STUCK_AFTER_MS);
    for (const id of ids) {
      await this.queues.add(
        'resume-dispatch',
        'dispatch',
        { uploadId: id },
        {
          jobId: jobId('redispatch', id, bucket),
        },
      );
    }
    return ids.length;
  }
}
