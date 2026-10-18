import { Inject, Injectable } from '@nestjs/common';
import { PinoLogger } from 'nestjs-pino';
import type { z } from 'zod';
import { Clock } from '../../../../platform/clock/clock.js';
import { InlineDelivery } from '../../../../platform/outbox/inline-delivery.js';
import { TxRunner } from '../../../../platform/tx/tx-runner.js';
import { DeliveryRepository, type DeliveryRow } from './delivery.repository.js';
import { ItemEventsHandler } from './item-events.handler.js';
import { LifecycleEventsHandler } from './lifecycle-events.handler.js';
import * as schemas from './payload-schemas.js';
import { type DeliveryPlan, IGNORE } from './plan.js';
import { ReviewEventsHandler } from './review-events.handler.js';

type Planned = DeliveryPlan | { kind: 'invalid' };

/**
 * Processes one stored delivery (architecture 7.3 item 4). The plan is made first: the payload is
 * validated, GitHub and other modules are asked what is needed. Then one transaction locks the
 * delivery row, runs the writes, hands the events they wrote to their consumers and marks the delivery,
 * so a second worker (the sweeper queued it again) either waits and finds it done, or does the same
 * work once.
 */
@Injectable()
export class DeliveryProcessor {
  constructor(
    @Inject(DeliveryRepository) private readonly deliveries: DeliveryRepository,
    @Inject(ItemEventsHandler) private readonly itemEvents: ItemEventsHandler,
    @Inject(ReviewEventsHandler) private readonly reviewEvents: ReviewEventsHandler,
    @Inject(LifecycleEventsHandler) private readonly lifecycle: LifecycleEventsHandler,
    @Inject(InlineDelivery) private readonly inline: InlineDelivery,
    @Inject(TxRunner) private readonly tx: TxRunner,
    @Inject(Clock) private readonly clock: Clock,
    @Inject(PinoLogger) private readonly logger: PinoLogger,
  ) {}

  async process(deliveryId: string): Promise<void> {
    const row = await this.deliveries.find(deliveryId);
    if (row?.status !== 'received') return;
    await this.deliveries.countAttempt(deliveryId);
    const plan = await this.plan(row);
    await this.tx.run(async () => {
      if ((await this.deliveries.lock(deliveryId))?.status !== 'received') return;
      const events = plan.kind === 'apply' ? await plan.run() : [];
      // The consumers run now, in this transaction: a delivery is `processed` at the very moment its
      // contributions exist, never before (FR-GH-05).
      await this.inline.deliver(events);
      const status = { apply: 'processed', ignore: 'ignored', invalid: 'failed' } as const;
      await this.deliveries.finish(deliveryId, status[plan.kind], this.clock.now());
    });
  }

  /** The last attempt failed: the delivery is `failed`, the payload stays for the investigation until the retention ends. */
  async fail(deliveryId: string): Promise<void> {
    await this.deliveries.finish(deliveryId, 'failed', this.clock.now(), { keepPayload: true });
  }

  private async plan(row: DeliveryRow): Promise<Planned> {
    const receivedAt = row.receivedAt;
    switch (row.event) {
      case 'issues': {
        const event = this.parse(row, schemas.issuesEvent);
        if (event === undefined) return { kind: 'invalid' };
        return this.itemEvents.issue(repoOf(event), event.issue, receivedAt);
      }
      case 'pull_request': {
        const event = this.parse(row, schemas.pullRequestEvent);
        if (event === undefined) return { kind: 'invalid' };
        return this.itemEvents.pullRequest(repoOf(event), event.pull_request, receivedAt);
      }
      case 'pull_request_review': {
        const event = this.parse(row, schemas.reviewEvent);
        if (event === undefined) return { kind: 'invalid' };
        return this.reviewEvents.review(event, receivedAt);
      }
      case 'installation': {
        const event = this.parse(row, schemas.installationEvent);
        if (event === undefined) return { kind: 'invalid' };
        return this.lifecycle.installation(event);
      }
      case 'installation_repositories': {
        const event = this.parse(row, schemas.installationRepositoriesEvent);
        if (event === undefined) return { kind: 'invalid' };
        return this.lifecycle.installationRepositories(event);
      }
      case 'repository': {
        const event = this.parse(row, schemas.repositoryEvent);
        if (event === undefined) return { kind: 'invalid' };
        return this.lifecycle.repository(event);
      }
      default:
        return IGNORE;
    }
  }

  /** `undefined` for a payload that does not fit; only the names of the failing fields are logged, never values. */
  private parse<S extends z.ZodType>(row: DeliveryRow, schema: S): z.infer<S> | undefined {
    const parsed = schema.safeParse(row.payload);
    if (parsed.success) return parsed.data;
    this.logger.warn(
      {
        delivery_id: row.deliveryId,
        event: row.event,
        fields: parsed.error.issues.map((issue) => issue.path.join('.')),
      },
      'webhook payload does not fit the schema',
    );
    return undefined;
  }
}

function repoOf(event: { repository: { id: number }; installation: { id: number } }): {
  repositoryId: number;
  installationId: number;
} {
  return { repositoryId: event.repository.id, installationId: event.installation.id };
}
