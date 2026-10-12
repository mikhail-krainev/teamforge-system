import { Inject, Injectable } from '@nestjs/common';
import { APP_CONFIG } from '../../../../platform/config/config.module.js';
import type { AppConfig } from '../../../../platform/config/config.js';
import { MailService } from '../../../../platform/mail/mail.service.js';
import { magicLinkMessage } from '../magic-link/magic-link-mail.js';
import { IdentitySignalsService } from '../services/identity-signals.service.js';
import { type AuthCallbacks, MAGIC_LINK_TTL_SECONDS } from './create-auth.js';

/** Hooks from the library into the application: the link mail goes to the queue, sign-ins leave signals. */
@Injectable()
export class AuthCallbacksImpl implements AuthCallbacks {
  constructor(
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    @Inject(MailService) private readonly mail: MailService,
    @Inject(IdentitySignalsService) private readonly signals: IdentitySignalsService,
  ) {}

  /** The link opens a page of the web app, the token stays in the fragment (SEC-09). */
  async sendMagicLink(email: string, token: string): Promise<void> {
    const link = `${this.config.APP_ORIGIN}/auth/confirm#token=${token}`;
    await this.mail.enqueue(magicLinkMessage(email, link, MAGIC_LINK_TTL_SECONDS / 60));
  }

  recordSignIn(
    userId: string,
    ip: string | null | undefined,
    userAgent: string | null | undefined,
  ): Promise<void> {
    return this.signals.record(userId, ip, userAgent);
  }
}
