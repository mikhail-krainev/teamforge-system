import { Controller, Get, Inject, Post, Req, Res } from '@nestjs/common';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { APP_CONFIG } from '../../../../platform/config/config.module.js';
import type { AppConfig } from '../../../../platform/config/config.js';
import { Authz, NoIdempotency } from '../../../../platform/http/operation.decorator.js';
import type { Auth } from '../better-auth/create-auth.js';
import { AUTH } from '../better-auth/tokens.js';
import { forwardToAuth } from '../better-auth/web-bridge.js';

/**
 * Better Auth routes of the contract (`/auth/*`, tag auth-library). Each one is an explicit Nest
 * route with `@Authz(operationId)`, so the global AuthzGuard and ValidationGuard run before the
 * library sees the request; nothing else of the library is reachable (no catch-all). The library
 * handler produces the answer, cookies included. Idempotency-Key does not apply (ADR-0004).
 */
@Controller('auth')
export class AuthController {
  constructor(
    @Inject(AUTH) private readonly auth: Auth,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  private forward(request: FastifyRequest, reply: FastifyReply): Promise<void> {
    return forwardToAuth(this.auth, this.config.BETTER_AUTH_URL, request, reply);
  }

  @Post('sign-in/social')
  @Authz('signInSocial')
  @NoIdempotency()
  signInSocial(@Req() request: FastifyRequest, @Res() reply: FastifyReply): Promise<void> {
    return this.forward(request, reply);
  }

  @Post('link-social')
  @Authz('linkGithub')
  @NoIdempotency()
  linkGithub(@Req() request: FastifyRequest, @Res() reply: FastifyReply): Promise<void> {
    return this.forward(request, reply);
  }

  @Post('sign-out')
  @Authz('signOut')
  @NoIdempotency()
  signOut(@Req() request: FastifyRequest, @Res() reply: FastifyReply): Promise<void> {
    return this.forward(request, reply);
  }

  @Get('get-session')
  @Authz('getSession')
  getSession(@Req() request: FastifyRequest, @Res() reply: FastifyReply): Promise<void> {
    return this.forward(request, reply);
  }

  /** OAuth redirect target of the GitHub App; not an API operation of the contract. */
  @Get('callback/:provider')
  @Authz('authOAuthCallback')
  oauthCallback(@Req() request: FastifyRequest, @Res() reply: FastifyReply): Promise<void> {
    return this.forward(request, reply);
  }
}
