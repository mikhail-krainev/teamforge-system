import { Inject, Injectable, type OnModuleInit } from '@nestjs/common';
import { type JobProcessor, ProcessorRegistry } from '../../../../platform/queues/queue-workers.js';
import type { QueueJob } from '../../../../platform/queues/queues.service.js';
import { DeliveryProcessor } from '../webhook/delivery-processor.service.js';

function deliveryIdOf(job: QueueJob): string {
  const id = job.data['deliveryId'];
  if (typeof id !== 'string' || id === '') throw new Error('github-webhook job without deliveryId');
  return id;
}

/** BullMQ processor of the `github-webhook` queue: one job per delivery, `jobId` = `X-GitHub-Delivery`. */
@Injectable()
export class GithubWebhookProcessor implements JobProcessor, OnModuleInit {
  readonly queue = 'github-webhook' as const;

  constructor(
    @Inject(ProcessorRegistry) private readonly registry: ProcessorRegistry,
    @Inject(DeliveryProcessor) private readonly deliveries: DeliveryProcessor,
  ) {}

  onModuleInit(): void {
    this.registry.register(this);
  }

  process(job: QueueJob): Promise<void> {
    return this.deliveries.process(deliveryIdOf(job));
  }

  onExhausted(job: QueueJob): Promise<void> {
    return this.deliveries.fail(deliveryIdOf(job));
  }
}
