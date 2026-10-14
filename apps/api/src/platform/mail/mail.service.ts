import { randomUUID } from 'node:crypto';
import { Inject, Injectable, type OnApplicationShutdown } from '@nestjs/common';
import { createTransport, type Transporter } from 'nodemailer';
import { APP_CONFIG } from '../config/config.module.js';
import type { AppConfig } from '../config/config.js';
import { InvariantError } from '../errors/domain-error.js';
import { SecretBox } from '../crypto/secret-box.js';
import { assertValidJobId } from '../queues/job-id.js';
import { QueuesService } from '../queues/queues.service.js';

export interface MailMessage {
  to: string;
  subject: string;
  text: string;
  html?: string;
}

export interface EnqueueMailOptions {
  /**
   * Deterministic BullMQ job id (see `jobId()`): queuing the same id again is a no-op, so a retried
   * transaction sends one mail. Without it every call is a new message.
   */
  jobId?: string;
}

/** Name of the `notifications` job that sends one e-mail. */
export const SEND_MAIL_JOB = 'send-mail';

/**
 * Outgoing e-mail (architecture 13.13). The API only queues a message: the address and the body
 * (they may carry one-time tokens) travel sealed with `DATA_ENCRYPTION_KEY`, so Redis never holds
 * them readable. The worker opens the job and talks SMTP.
 */
@Injectable()
export class MailService implements OnApplicationShutdown {
  private transport: Transporter | undefined;

  constructor(
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    @Inject(QueuesService) private readonly queues: QueuesService,
    @Inject(SecretBox) private readonly box: SecretBox,
  ) {}

  /** Queues a message for the worker. By default a random job id: every message is sent. */
  async enqueue(message: MailMessage, options: EnqueueMailOptions = {}): Promise<void> {
    if (options.jobId !== undefined) assertValidJobId(options.jobId);
    await this.queues.add(
      'notifications',
      SEND_MAIL_JOB,
      { sealed: this.box.seal(JSON.stringify(message)) },
      { jobId: options.jobId ?? `mail_${randomUUID()}` },
    );
  }

  /** Worker side: opens a queued message and sends it over SMTP. */
  async deliverSealed(sealed: string): Promise<void> {
    const message = JSON.parse(this.box.open(sealed)) as MailMessage;
    await this.transporter().sendMail({
      from: this.config.MAIL_FROM,
      to: message.to,
      subject: message.subject,
      text: message.text,
      ...(message.html === undefined ? {} : { html: message.html }),
    });
  }

  private transporter(): Transporter {
    if (this.transport !== undefined) return this.transport;
    if (this.config.SMTP_URL === undefined) throw new InvariantError('SMTP_URL is not configured');
    this.transport = createTransport(this.config.SMTP_URL);
    return this.transport;
  }

  onApplicationShutdown(): void {
    this.transport?.close();
  }
}
