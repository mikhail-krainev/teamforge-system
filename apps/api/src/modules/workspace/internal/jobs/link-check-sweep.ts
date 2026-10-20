import { Inject, Injectable, type OnModuleInit } from '@nestjs/common';
import { PinoLogger } from 'nestjs-pino';
import { Clock } from '../../../../platform/clock/clock.js';
import { MaintenanceTasks } from '../../../../platform/queues/maintenance-tasks.js';
import { QueuesService } from '../../../../platform/queues/queues.service.js';
import { TxRunner } from '../../../../platform/tx/tx-runner.js';
import {
  CHECK_ITEM_LINK_JOB,
  LINK_CHECK_QUEUE,
  linkCheckJobId,
} from '../../../../link-checker/protocol.js';
import { LinkCheckRepository, type WaitingLink } from '../repositories/link-check.repository.js';
import { LinkResultService } from '../services/link-result.service.js';

const MINUTE_MS = 60_000;
/** A link without an answer this long is asked about again. */
export const LINK_STALE_AFTER_MS = 5 * MINUTE_MS;
/** ... and is given up (`broken`, a warning) after this long. */
export const LINK_GIVE_UP_AFTER_MS = 60 * MINUTE_MS;
const SWEEP_BATCH = 100;

/**
 * Repairs what the queue events cannot promise (S5-09): a job lost with Redis, an answer that came
 * while the `worker` was down, a checker that failed all its attempts. A link still `unchecked`
 * after five minutes is queued again under a new job id (one per window, so the sweep itself is
 * idempotent); after an hour it is given up as `broken`. Applying an answer twice changes nothing.
 */
@Injectable()
export class LinkCheckSweep implements OnModuleInit {
  constructor(
    @Inject(MaintenanceTasks) private readonly maintenance: MaintenanceTasks,
    @Inject(TxRunner) private readonly tx: TxRunner,
    @Inject(Clock) private readonly clock: Clock,
    @Inject(QueuesService) private readonly queues: QueuesService,
    @Inject(LinkCheckRepository) private readonly links: LinkCheckRepository,
    @Inject(LinkResultService) private readonly results: LinkResultService,
    @Inject(PinoLogger) private readonly logger: PinoLogger,
  ) {}

  onModuleInit(): void {
    this.maintenance.register({
      name: 'link-check-sweep',
      everyMs: LINK_STALE_AFTER_MS,
      run: () => this.sweep(),
    });
  }

  /** Returns the number of links handled. */
  async sweep(): Promise<number> {
    const now = this.clock.now();
    const waiting = await this.tx.run(() =>
      this.links.waitingSince(new Date(now.getTime() - LINK_STALE_AFTER_MS), SWEEP_BATCH),
    );
    for (const link of waiting) {
      try {
        await this.handleOne(link, now);
      } catch (error) {
        this.logger.error({ err: error }, `link-check-sweep failed for item ${link.id}`);
      }
    }
    return waiting.length;
  }

  private async handleOne(link: WaitingLink, now: Date): Promise<void> {
    if (now.getTime() - link.updatedAt.getTime() >= LINK_GIVE_UP_AFTER_MS) {
      await this.results.giveUp(link.teamId, link.id, link.linkUrl);
      return;
    }
    const round = Math.floor(now.getTime() / LINK_STALE_AFTER_MS);
    await this.queues.add(
      LINK_CHECK_QUEUE,
      CHECK_ITEM_LINK_JOB,
      { teamId: link.teamId, itemId: link.id, version: link.version, url: link.linkUrl },
      { jobId: linkCheckJobId(link.id, link.version, round) },
    );
  }
}
