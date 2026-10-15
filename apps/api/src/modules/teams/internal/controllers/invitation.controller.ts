import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Inject,
  Param,
  Post,
  Query,
} from '@nestjs/common';
import { ClsService } from 'nestjs-cls';
import type { Body as BodyOf, Ok } from 'shared';
import { requireUserId } from '../../../../platform/context/cls-store.js';
import { Authz, NoIdempotency } from '../../../../platform/http/operation.decorator.js';
import { InvitationAcceptService } from '../services/invitation-accept.service.js';
import { InvitationService, type InvitationsQuery } from '../services/invitation.service.js';

/** Invitations of friends (FR-TEAM-08, FR-TEAM-09). */
@Controller('v1')
export class InvitationController {
  constructor(
    @Inject(InvitationService) private readonly invitations: InvitationService,
    @Inject(InvitationAcceptService) private readonly acceptance: InvitationAcceptService,
    @Inject(ClsService) private readonly cls: ClsService,
  ) {}

  @Post('teams/:teamId/invitations')
  @Authz('createInvitation')
  createInvitation(
    @Param('teamId') teamId: string,
    @Body() body: BodyOf<'createInvitation'>,
  ): Promise<Ok<'createInvitation'>> {
    return this.invitations.create(requireUserId(this.cls), teamId, body);
  }

  @Get('teams/:teamId/invitations')
  @Authz('listInvitations')
  listInvitations(
    @Param('teamId') teamId: string,
    @Query() query: InvitationsQuery,
  ): Promise<Ok<'listInvitations'>> {
    return this.invitations.list(teamId, query);
  }

  @Delete('teams/:teamId/invitations/:invitationId')
  @HttpCode(204)
  @Authz('revokeInvitation')
  async revokeInvitation(
    @Param('teamId') teamId: string,
    @Param('invitationId') invitationId: string,
  ): Promise<void> {
    await this.invitations.revoke(requireUserId(this.cls), teamId, invitationId);
  }

  /** Safe POST: the token is in the body, nothing is written, no Idempotency-Key (architecture 14). */
  @Post('invitation-previews')
  @HttpCode(200)
  @NoIdempotency()
  @Authz('previewInvitation')
  previewInvitation(@Body() body: BodyOf<'previewInvitation'>): Promise<Ok<'previewInvitation'>> {
    return this.acceptance.preview(requireUserId(this.cls), body.token);
  }

  @Post('invitation-acceptances')
  @HttpCode(200)
  @Authz('acceptInvitation')
  acceptInvitation(@Body() body: BodyOf<'acceptInvitation'>): Promise<Ok<'acceptInvitation'>> {
    return this.acceptance.accept(requireUserId(this.cls), body.token);
  }
}
