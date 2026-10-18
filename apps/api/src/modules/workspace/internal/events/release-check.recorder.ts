import { createHash } from 'node:crypto';
import { Inject, Injectable, type OnModuleInit } from '@nestjs/common';
import { Clock } from '../../../../platform/clock/clock.js';
import { ResultListeners } from '../../../../platform/queues/result-listeners.js';
import { TxRunner } from '../../../../platform/tx/tx-runner.js';
import {
  LINK_CHECK_QUEUE,
  type LinkCheckResult,
  linkCheckResultSchema,
} from '../../../../link-checker/protocol.js';
import { CompletionRepository } from '../repositories/completion.repository.js';
import { ReleaseTargetService } from '../services/release-target.service.js';

/** Jobs queued when a link is saved are named so (`linkCheckJobId`); the checks of a completion have their own names. */
const SAVE_JOB_PREFIX = 'item-link_';

/** A UUID made from the job id, so the same answer delivered twice is one row. */
export function releaseCheckIdOf(jobId: string): string {
  const hex = createHash('sha1').update(`release-check:${jobId}`).digest('hex');
  const variant = ((Number.parseInt(hex.slice(16, 18), 16) & 0x3f) | 0x80).toString(16);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-5${hex.slice(13, 16)}-${variant}${hex.slice(18, 20)}-${hex.slice(20, 32)}`;
}

/**
 * The first look at the release (FR-WORK-14): the answer of the check made when the link of the release step
 * was saved is kept in `release_check`; the second check of the completion comes at least 24 hours after it.
 * It reads the same `link-check` results as `LinkResultService` and touches nothing else.
 */
@Injectable()
export class ReleaseCheckRecorder implements OnModuleInit {
  readonly queue = LINK_CHECK_QUEUE;

  constructor(
    @Inject(ResultListeners) private readonly listeners: ResultListeners,
    @Inject(TxRunner) private readonly tx: TxRunner,
    @Inject(Clock) private readonly clock: Clock,
    @Inject(CompletionRepository) private readonly completions: CompletionRepository,
    @Inject(ReleaseTargetService) private readonly targets: ReleaseTargetService,
  ) {}

  onModuleInit(): void {
    this.listeners.register(this);
  }

  async handle(jobId: string, raw: unknown): Promise<void> {
    if (!jobId.startsWith(SAVE_JOB_PREFIX)) return;
    const parsed = linkCheckResultSchema.safeParse(raw);
    if (parsed.success) await this.record(jobId, parsed.data);
  }

  private async record(jobId: string, result: LinkCheckResult): Promise<void> {
    await this.tx.run(async () => {
      const release = await this.completions.findReleaseItem(result.teamId);
      if (release?.id !== result.itemId) return;
      await this.completions.insertReleaseCheck({
        id: releaseCheckIdOf(jobId),
        teamId: result.teamId,
        url: result.url,
        checkKey: await this.targets.checkKeyOf(result.teamId, release.stepKey),
        completionCheckId: null,
        ok: result.outcome.ok,
        httpStatus: result.outcome.httpStatus,
        reason: result.outcome.ok ? null : result.outcome.reason,
        checkedAt: result.savedAt === undefined ? this.clock.now() : new Date(result.savedAt),
      });
    });
  }
}
