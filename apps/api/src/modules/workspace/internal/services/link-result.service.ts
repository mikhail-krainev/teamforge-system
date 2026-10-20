import { Inject, Injectable, type OnModuleInit } from '@nestjs/common';
import { Clock } from '../../../../platform/clock/clock.js';
import { OutboxService } from '../../../../platform/outbox/outbox.service.js';
import {
  LINK_CHECK_QUEUE,
  type LinkCheckResult,
  linkCheckResultSchema,
} from '../../../../link-checker/protocol.js';
import { ResultListeners } from '../../../../platform/queues/result-listeners.js';
import { TxRunner } from '../../../../platform/tx/tx-runner.js';
import { WORKSPACE_MODULE } from '../../public.js';
import { type LinkStatus, linkStatusOf } from '../domain/link-policy.js';
import { LinkCheckRepository } from '../repositories/link-check.repository.js';

/**
 * Applies the answer of the `link-checker` to the item (FR-WORK-04, FR-PLAY-08 `link_https`). The
 * answer is a code; the item gets `ok`, `broken` (a warning) or `rejected` (the SSRF policy refused
 * the address: a blocking check). Runs in the `worker` process from the queue events and from the sweep.
 */
@Injectable()
export class LinkResultService implements OnModuleInit {
  readonly queue = LINK_CHECK_QUEUE;

  constructor(
    @Inject(ResultListeners) private readonly listeners: ResultListeners,
    @Inject(TxRunner) private readonly tx: TxRunner,
    @Inject(Clock) private readonly clock: Clock,
    @Inject(OutboxService) private readonly outbox: OutboxService,
    @Inject(LinkCheckRepository) private readonly links: LinkCheckRepository,
  ) {}

  onModuleInit(): void {
    this.listeners.register(this);
  }

  /** A result that does not match the protocol is dropped: the sweep asks again. */
  async handle(_jobId: string, raw: unknown): Promise<void> {
    const parsed = linkCheckResultSchema.safeParse(raw);
    if (parsed.success) await this.apply(parsed.data);
  }

  /** Returns whether the item changed (false for a stale, repeated or foreign answer). */
  apply(result: LinkCheckResult): Promise<boolean> {
    return this.settle(result.teamId, result.itemId, result.url, linkStatusOf(result.outcome));
  }

  /** The sweep gives a link up when no answer came for too long: it counts as broken, a warning only. */
  giveUp(teamId: string, itemId: string, url: string): Promise<boolean> {
    return this.settle(teamId, itemId, url, 'broken');
  }

  private settle(
    teamId: string,
    itemId: string,
    url: string,
    status: LinkStatus,
  ): Promise<boolean> {
    return this.tx.run(async () => {
      const version = await this.links.settle(teamId, itemId, url, status, this.clock.now());
      if (version === undefined) return false;
      await this.outbox.publish({
        module: WORKSPACE_MODULE,
        type: 'item_updated',
        aggregateId: itemId,
        payload: { teamId, itemId, version },
      });
      return true;
    });
  }
}
