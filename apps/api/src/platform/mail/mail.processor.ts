import { Inject, Injectable, type OnModuleInit } from '@nestjs/common';
import { type JobProcessor, ProcessorRegistry } from '../queues/queue-workers.js';
import type { QueueJob } from '../queues/queues.service.js';
import { MailService, SEND_MAIL_JOB } from './mail.service.js';

/** `notifications` queue: sends queued e-mails. Registered in both processes, runs in the worker only. */
@Injectable()
export class MailProcessor implements JobProcessor, OnModuleInit {
  readonly queue = 'notifications' as const;

  constructor(
    @Inject(ProcessorRegistry) private readonly registry: ProcessorRegistry,
    @Inject(MailService) private readonly mail: MailService,
  ) {}

  onModuleInit(): void {
    this.registry.register(this);
  }

  async process(job: QueueJob): Promise<void> {
    const { sealed } = job.data as { sealed?: string };
    if (job.name !== SEND_MAIL_JOB || typeof sealed !== 'string') {
      throw new Error(`Unknown notifications job: ${job.name}`);
    }
    await this.mail.deliverSealed(sealed);
  }
}
