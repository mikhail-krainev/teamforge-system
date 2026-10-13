import { Body, Controller, HttpCode, Inject, Post, Req } from '@nestjs/common';
import type { FastifyRequest } from 'fastify';
import { ClsService } from 'nestjs-cls';
import { requireUserId } from '../../../../platform/context/cls-store.js';
import { Authz, NoIdempotency } from '../../../../platform/http/operation.decorator.js';
import type { DeletionDto } from './deletion.repository.js';
import { type DeletionReason, DeletionRequestService } from './deletion-request.service.js';

/** requestDeletion and cancelDeletionRequest (FR-AUTH-09, SEC-17). */
@Controller('v1')
export class DeletionController {
  constructor(
    @Inject(DeletionRequestService) private readonly deletion: DeletionRequestService,
    @Inject(ClsService) private readonly cls: ClsService,
  ) {}

  @Post('me/deletion-requests')
  @HttpCode(202)
  @Authz('requestDeletion')
  requestDeletion(@Body() body: { reason: DeletionReason }): Promise<DeletionDto> {
    return this.deletion.request(requireUserId(this.cls), body.reason);
  }

  @Post('deletion-request-cancellations')
  @HttpCode(200)
  @Authz('cancelDeletionRequest')
  @NoIdempotency()
  cancelDeletionRequest(
    @Body() body: { token: string },
    @Req() request: FastifyRequest,
  ): Promise<DeletionDto> {
    return this.deletion.cancel(request.ip, body.token);
  }
}
