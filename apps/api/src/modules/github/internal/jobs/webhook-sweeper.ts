import { Inject, Injectable, type OnModuleInit } from '@nestjs/common';
import { PinoLogger } from 'nestjs-pino';
import { Clock } from '../../../../platform/clock/clock.js';
import { MaintenanceTasks } from '../../../../platform/queues/maintenance-tasks.js';
import { QueuesService } from '../../../../platform/queues/queues.service.js';
import { DeliveryRepository, type DeliveryRow } from '../webhook/delivery.repository.js';
import { WEBHOOK_JOB, WEBHOOK_QUEUE } from '../webhook/event-routing.js';

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;
/** A delivery that is still `received` this long was not queued, or its job was lost (architecture 7.3 item 3). */
export const DELIVERY_STUCK_AFTER_MS = MINUTE_MS;
/** C-56: handled deliveries are kept this long. */
export const DELIVERY_RETENTION_MS = 7 * DAY_MS;
/** Processing attempts after which a delivery is given up as `failed` instead of being queued again. */
export const DELIVERY_MAX_ATTEMPTS = 10;
const SWEEP_BATCH = 200;

/**
 * The safety net of the webhook path: deliveries stored but not queued (the process died between the
 * insert and the queue) or not processed are queued again, and old rows are deleted. Both tasks are safe to run
 * twice: a job id is queued once, and the processor locks the delivery row.
 */
@Injectable()
export class WebhookSweeper implements OnModuleInit {
  constructor(
    @Inject(MaintenanceTasks) private readonly maintenance: MaintenanceTasks,
    @Inject(DeliveryRepository) private readonly deliveries: DeliveryRepository,
    @Inject(QueuesService) private readonly queues: QueuesService,
    @Inject(Clock) private readonly clock: Clock,
    @Inject(PinoLogger) private readonly logger: PinoLogger,
  ) {}

  onModuleInit(): void {
    this.maintenance.register({
      name: 'webhook-sweeper',
      everyMs: MINUTE_MS,
      run: () => this.requeueStuck(),
    });
    this.maintenance.register({
      name: 'webhook-cleanup',
      everyMs: HOUR_MS,
      run: () =>
        this.deliveries.deleteOlderThan(
          new Date(this.clock.now().getTime() - DELIVERY_RETENTION_MS),
        ),
    });
  }

  /** Returns the number of deliveries handled. */
  async requeueStuck(): Promise<number> {
    const before = new Date(this.clock.now().getTime() - DELIVERY_STUCK_AFTER_MS);
    const stuck = await this.deliveries.receivedBefore(before, SWEEP_BATCH);
    for (const delivery of stuck) {
      try {
        await this.handle(delivery);
      } catch (error) {
        this.logger.error(
          { err: error, delivery_id: delivery.deliveryId },
          'webhook-sweeper failed',
        );
      }
    }
    return stuck.length;
  }

  private async handle(delivery: DeliveryRow): Promise<void> {
    if (delivery.attempts >= DELIVERY_MAX_ATTEMPTS) {
      await this.deliveries.finish(delivery.deliveryId, 'failed', this.clock.now(), {
        keepPayload: true,
      });
      return;
    }
    await this.requeue(delivery.deliveryId);
  }

  /**
   * The job id is the delivery id, and BullMQ keeps finished jobs for a while: adding under the same id
   * would silently do nothing. A job that is waiting, delayed or running is left alone; a finished one
   * (it failed, or it completed and the row still says `received`) is removed and queued again.
   */
  private async requeue(deliveryId: string): Promise<void> {
    const queue = this.queues.getQueue(WEBHOOK_QUEUE);
    const existing = await queue.getJob(deliveryId);
    if (existing !== undefined) {
      const state = await existing.getState();
      if (state !== 'failed' && state !== 'completed') return;
      await existing.remove();
    }
    await this.queues.add(WEBHOOK_QUEUE, WEBHOOK_JOB, { deliveryId }, { jobId: deliveryId });
  }
}
