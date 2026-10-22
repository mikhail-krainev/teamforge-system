import { Global, Module } from '@nestjs/common';
import type { Redis } from 'ioredis';
import { CONSENT_GATE, SESSION_AUTHENTICATOR } from '../../platform/authz/actor-policies.js';
import { APP_CONFIG } from '../../platform/config/config.module.js';
import type { AppConfig } from '../../platform/config/config.js';
import { DB, type Database } from '../../platform/db/db.module.js';
import { REDIS } from '../../platform/redis/redis.module.js';
import { AUTH_API } from './public.js';
import { createAuth } from './internal/better-auth/create-auth.js';
import { AUTH } from './internal/better-auth/tokens.js';
import { ConsentGuard } from './internal/consent/consent.gate.js';
import { ConsentService } from './internal/consent/consent.service.js';
import { AuthCallbacksImpl } from './internal/better-auth/auth-callbacks.js';
import { DeletionController } from './internal/deletion/deletion.controller.js';
import { DeletionMailConsumer } from './internal/deletion/deletion-mail.consumer.js';
import { DeletionSessionsConsumer } from './internal/deletion/deletion-sessions.consumer.js';
import { DeletionRepository } from './internal/deletion/deletion.repository.js';
import { DeletionRequestService } from './internal/deletion/deletion-request.service.js';
import { DeletionSagaService } from './internal/deletion/deletion-saga.service.js';
import { AuthController } from './internal/controllers/auth.controller.js';
import { LoginRateLimitGuard } from './internal/magic-link/login-rate-limit.guard.js';
import { MagicLinkController } from './internal/magic-link/magic-link.controller.js';
import { MagicLinkService } from './internal/magic-link/magic-link.service.js';
import { IdentitySignalsService } from './internal/services/identity-signals.service.js';
import { MeController } from './internal/controllers/me.controller.js';
import { MeService } from './internal/services/me.service.js';
import { AuthService } from './internal/services/auth.service.js';
import { AuthOperations } from './internal/services/auth-operations.js';
import { BetterAuthSessionAuthenticator } from './internal/services/session.authenticator.js';
import { SessionRevoker } from './internal/services/session-revoker.js';

/**
 * Authentication: Better Auth with sessions in Redis. Global because the platform's AuthzGuard
 * looks up the session authenticator by token.
 */
@Global()
@Module({
  controllers: [AuthController, MagicLinkController, MeController, DeletionController],
  providers: [
    {
      provide: AUTH,
      // The only module use of the shared client (see the no-restricted-imports rule): Better Auth runs
      // its own statements in the sign-in handlers, never inside a TxRunner transaction.
      inject: [DB, REDIS, APP_CONFIG, AuthCallbacksImpl],
      useFactory: (db: Database, redis: Redis, config: AppConfig, callbacks: AuthCallbacksImpl) =>
        createAuth({ db, redis, config, callbacks }),
    },
    IdentitySignalsService,
    DeletionRepository,
    DeletionRequestService,
    DeletionMailConsumer,
    DeletionSessionsConsumer,
    DeletionSagaService,
    AuthCallbacksImpl,
    MagicLinkService,
    LoginRateLimitGuard,
    BetterAuthSessionAuthenticator,
    { provide: SESSION_AUTHENTICATOR, useExisting: BetterAuthSessionAuthenticator },
    SessionRevoker,
    ConsentService,
    MeService,
    AuthService,
    { provide: AUTH_API, useExisting: AuthService },
    AuthOperations,
    ConsentGuard,
    { provide: CONSENT_GATE, useExisting: ConsentGuard },
  ],
  exports: [
    SESSION_AUTHENTICATOR,
    CONSENT_GATE,
    BetterAuthSessionAuthenticator,
    SessionRevoker,
    AUTH,
    AUTH_API,
    ConsentService,
  ],
})
export class AuthModule {}
