import { Inject, Injectable } from '@nestjs/common';
import { PinoLogger } from 'nestjs-pino';
import { Clock } from '../../../../platform/clock/clock.js';
import { DomainError } from '../../../../platform/errors/domain-error.js';
import { RateLimiter } from '../../../../platform/ratelimit/rate-limiter.js';
import { assertValidJobId } from '../../../../platform/queues/job-id.js';
import { QueuesService } from '../../../../platform/queues/queues.service.js';
import { InstallationRepository } from '../installation/installation.repository.js';
import { RepoLinkRepository } from '../services/repo-link.repository.js';
import { isHandledEvent, WEBHOOK_JOB, WEBHOOK_QUEUE } from './event-routing.js';
import { type Envelope, readEnvelope } from './payload-schemas.js';
import { DeliveryRepository } from './delivery.repository.js';

const EVENT_NAME = /^[a-z_]{1,64}$/;
const DELIVERY_ID = /^[A-Za-z0-9._-]{1,64}$/;

export interface IncomingDelivery {
  event: string | undefined;
  deliveryId: string | undefined;
  /** The bytes the signature was computed over; the policy of the route has already verified them. */
  rawBody: Buffer;
}

function badRequest(detail: string): DomainError {
  return new DomainError('VALIDATION_FAILED', 400, { detail });
}

function parseObject(rawBody: Buffer): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawBody.toString('utf8'));
  } catch {
    throw badRequest('body_not_json');
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw badRequest('body_not_object');
  }
  return parsed as Record<string, unknown>;
}

/**
 * Takes a signed delivery in (architecture 7.3 items 1-3): the row of `webhook_delivery` decides whether
 * it is new (`ON CONFLICT DO NOTHING`), an event nobody here uses or a repository nobody linked is stored
 * as `ignored` without its payload, everything else is queued as `github-webhook` under the delivery id.
 * The answer never waits for the processing.
 */
@Injectable()
export class WebhookReceiver {
  constructor(
    @Inject(DeliveryRepository) private readonly deliveries: DeliveryRepository,
    @Inject(RepoLinkRepository) private readonly links: RepoLinkRepository,
    @Inject(InstallationRepository) private readonly installations: InstallationRepository,
    @Inject(RateLimiter) private readonly limiter: RateLimiter,
    @Inject(QueuesService) private readonly queues: QueuesService,
    @Inject(Clock) private readonly clock: Clock,
    @Inject(PinoLogger) private readonly logger: PinoLogger,
  ) {}

  async receive(input: IncomingDelivery): Promise<void> {
    const { event, deliveryId } = input;
    if (event === undefined || !EVENT_NAME.test(event)) throw badRequest('event_header');
    if (deliveryId === undefined || !DELIVERY_ID.test(deliveryId)) {
      throw badRequest('delivery_header');
    }
    assertDeliveryIdIsJobId(deliveryId);
    const payload = parseObject(input.rawBody);
    const envelope = readEnvelope(payload);
    if (envelope.installationId !== null) {
      await this.limiter.enforce('githubWebhook', `installation:${envelope.installationId}`);
    }
    const relevant = await this.isRelevant(event, envelope);
    const inserted = await this.deliveries.insert({
      deliveryId,
      event,
      action: envelope.action,
      installationId: envelope.installationId,
      repositoryId: envelope.repositoryId,
      payload: relevant ? payload : null,
      status: relevant ? 'received' : 'ignored',
      receivedAt: this.clock.now(),
    });
    if (inserted && relevant) await this.enqueue(deliveryId);
  }

  /** Not queued: the sweeper picks the row up if the queue was unreachable (item 3). */
  private async enqueue(deliveryId: string): Promise<void> {
    try {
      await this.queues.add(WEBHOOK_QUEUE, WEBHOOK_JOB, { deliveryId }, { jobId: deliveryId });
    } catch (error) {
      this.logger.warn({ err: error, delivery_id: deliveryId }, 'webhook job not queued');
    }
  }

  /**
   * A repository event is bound to the team through the active link of that repository AND of the
   * installation the delivery names (SEC-06: the signature proves GitHub, not whose repository it is).
   */
  private async isRelevant(event: string, envelope: Envelope): Promise<boolean> {
    const { installationId, repositoryId } = envelope;
    if (!isHandledEvent(event, envelope.action) || installationId === null) return false;
    if (event === 'installation' || event === 'installation_repositories') {
      return this.installations.exists(installationId);
    }
    if (repositoryId === null) return false;
    const link = await this.links.findActiveByRepository(repositoryId);
    return link?.installationId === installationId;
  }
}

/** Delivery ids are UUIDs; BullMQ refuses integer-like ids, and a sender may put anything in the header. */
function assertDeliveryIdIsJobId(deliveryId: string): void {
  try {
    assertValidJobId(deliveryId);
  } catch {
    throw badRequest('delivery_header');
  }
}
