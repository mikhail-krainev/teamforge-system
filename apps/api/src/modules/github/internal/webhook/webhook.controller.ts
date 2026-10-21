import { Controller, HttpCode, Inject, Post, Req } from '@nestjs/common';
import type { FastifyRequest } from 'fastify';
import { rawBodyOf } from '../../../../platform/http/raw-body-gate.js';
import { Authz, NoIdempotency } from '../../../../platform/http/operation.decorator.js';
import { WebhookReceiver } from './webhook-receiver.service.js';

const header = (request: FastifyRequest, name: string): string | undefined => {
  const value = request.headers[name];
  return typeof value === 'string' ? value : undefined;
};

/** receiveGithubWebhook (FR-GH-03, FR-GH-04). The signature was checked by the policy of the actor. */
@Controller('v1/webhooks/github')
export class WebhookController {
  constructor(@Inject(WebhookReceiver) private readonly receiver: WebhookReceiver) {}

  @Post()
  @Authz('receiveGithubWebhook')
  @NoIdempotency()
  @HttpCode(202)
  async receive(@Req() request: FastifyRequest): Promise<void> {
    await this.receiver.receive({
      event: header(request, 'x-github-event'),
      deliveryId: header(request, 'x-github-delivery'),
      rawBody: rawBodyOf(request),
    });
  }
}
