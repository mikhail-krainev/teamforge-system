import { Body, Controller, Get, Inject, Post, Req } from '@nestjs/common';
import type { FastifyRequest } from 'fastify';
import { ClsService } from 'nestjs-cls';
import { InvariantError } from '../../../../platform/errors/domain-error.js';
import { Authz } from '../../../../platform/http/operation.decorator.js';
import type { ConsentText } from '../consent/consent-text.js';
import { type ConsentRecord, ConsentService } from '../consent/consent.service.js';
import { type GithubAccountDto, type MeDto, MeService } from '../services/me.service.js';

/** getMe, getCurrentConsentText, acceptConsent (FR-AUTH-02, FR-AUTH-03). */
@Controller('v1')
export class MeController {
  constructor(
    @Inject(MeService) private readonly me: MeService,
    @Inject(ConsentService) private readonly consent: ConsentService,
    @Inject(ClsService) private readonly cls: ClsService,
  ) {}

  /** The user id set by AuthzGuard; these operations all need a session. */
  private userId(): string {
    const id = this.cls.get('userId');
    if (id === undefined) throw new InvariantError('Operation without a signed-in user');
    return id;
  }

  @Get('me')
  @Authz('getMe')
  getMe(): Promise<MeDto> {
    return this.me.getMe(this.userId());
  }

  @Get('me/github')
  @Authz('getMyGithubAccount')
  getMyGithubAccount(): Promise<GithubAccountDto> {
    return this.me.getGithubAccount(this.userId());
  }

  @Get('consent/current')
  @Authz('getCurrentConsentText')
  getCurrentConsentText(): ConsentText {
    return this.consent.currentText();
  }

  @Post('me/consents')
  @Authz('acceptConsent')
  acceptConsent(
    @Body() body: { version: string; textHash: string },
    @Req() request: FastifyRequest,
  ): Promise<ConsentRecord> {
    return this.consent.accept(this.userId(), body, request.ip);
  }
}
