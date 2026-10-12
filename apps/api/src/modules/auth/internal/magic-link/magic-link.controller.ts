import { Body, Controller, HttpCode, Inject, Post, Req, Res, UseGuards } from '@nestjs/common';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { Authz, NoIdempotency } from '../../../../platform/http/operation.decorator.js';
import { LoginRateLimitGuard } from './login-rate-limit.guard.js';
import { MagicLinkService } from './magic-link.service.js';

/** signInMagicLink and verifyMagicLink: thin wrappers over the Better Auth plugin (architecture 13.8). */
@Controller('auth')
export class MagicLinkController {
  constructor(@Inject(MagicLinkService) private readonly service: MagicLinkService) {}

  @Post('sign-in/magic-link')
  @HttpCode(200)
  @Authz('signInMagicLink')
  @NoIdempotency()
  signIn(
    @Body() body: { email: string },
    @Req() request: FastifyRequest,
  ): Promise<{ status: true }> {
    return this.service.request(request, body.email);
  }

  @Post('magic-link/confirm')
  @HttpCode(200)
  @Authz('verifyMagicLink')
  @NoIdempotency()
  @UseGuards(LoginRateLimitGuard)
  async confirm(
    @Body() body: { token: string; callbackURL?: string },
    @Req() request: FastifyRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
  ): Promise<{ redirectTo: string }> {
    const result = await this.service.verify(request, body.token, body.callbackURL);
    if (result.cookies.length > 0) void reply.header('set-cookie', result.cookies);
    return { redirectTo: result.redirectTo };
  }
}
