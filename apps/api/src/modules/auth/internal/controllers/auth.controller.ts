import { Controller, Get, Inject, Post, Req, Res, UseGuards } from '@nestjs/common';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { APP_CONFIG } from '../../../../platform/config/config.module.js';
import type { AppConfig } from '../../../../platform/config/config.js';
import { Authz, NoIdempotency } from '../../../../platform/http/operation.decorator.js';
import type { Auth } from '../better-auth/create-auth.js';
import { AUTH } from '../better-auth/tokens.js';
import { forwardToAuth, toWebHeaders } from '../better-auth/web-bridge.js';
import { LoginRateLimitGuard } from '../magic-link/login-rate-limit.guard.js';

/** Library error codes meaning "this GitHub account belongs to someone else" (FR-AUTH-05). */
const OWNED_BY_ANOTHER =
  /error=(account_already_linked_to_different_user|account_ownership_conflict)/;

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

  /** A failed OAuth round trip returns to the page the user came from, with `?error=<code>`. */
  private forwardWithErrorPage(request: FastifyRequest, reply: FastifyReply): Promise<void> {
    const body = (request.body ?? {}) as { callbackURL?: string };
    request.body = { ...body, errorCallbackURL: body.callbackURL ?? '/' };
    return this.forward(request, reply);
  }

  @Post('sign-in/social')
  @Authz('signInSocial')
  @NoIdempotency()
  @UseGuards(LoginRateLimitGuard)
  signInSocial(@Req() request: FastifyRequest, @Res() reply: FastifyReply): Promise<void> {
    return this.forwardWithErrorPage(request, reply);
  }

  @Post('link-social')
  @Authz('linkGithub')
  @NoIdempotency()
  linkGithub(@Req() request: FastifyRequest, @Res() reply: FastifyReply): Promise<void> {
    return this.forwardWithErrorPage(request, reply);
  }

  @Post('sign-out')
  @Authz('signOut')
  @NoIdempotency()
  signOut(@Req() request: FastifyRequest, @Res() reply: FastifyReply): Promise<void> {
    return this.forward(request, reply);
  }

  /** The session without its token (SEC-07): the cookie is the only holder of the secret. */
  @Get('get-session')
  @Authz('getSession')
  async getSession(@Req() request: FastifyRequest, @Res() reply: FastifyReply): Promise<void> {
    const result = await this.auth.api.getSession({
      headers: toWebHeaders(request),
      returnHeaders: true,
    });
    const found = result.response;
    const cookies = result.headers.getSetCookie();
    if (cookies.length > 0) void reply.header('set-cookie', cookies);
    void reply.type('application/json; charset=utf-8');
    if (found === null) return reply.send('null');
    const { id, userId, expiresAt, createdAt, updatedAt } = found.session;
    const { emailNormalized, ...user } = found.user as typeof found.user & {
      emailNormalized?: string | null;
    };
    void emailNormalized;
    const session = { id, userId, expiresAt, createdAt, updatedAt };
    return reply.send(JSON.stringify({ session, user }));
  }

  /** OAuth redirect target of the GitHub App; not an API operation of the contract. */
  @Get('callback/:provider')
  @Authz('authOAuthCallback')
  oauthCallback(@Req() request: FastifyRequest, @Res() reply: FastifyReply): Promise<void> {
    return forwardToAuth(this.auth, this.config.BETTER_AUTH_URL, request, reply, (location) =>
      location.replace(OWNED_BY_ANOTHER, 'error=GITHUB_ALREADY_LINKED'),
    );
  }
}
