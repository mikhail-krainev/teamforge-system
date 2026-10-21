import { Inject, Injectable, type OnModuleInit, Optional } from '@nestjs/common';
import { ActorPolicies } from '../../../../platform/authz/actor-policies.js';
import { APP_CONFIG } from '../../../../platform/config/config.module.js';
import type { AppConfig } from '../../../../platform/config/config.js';
import { DomainError } from '../../../../platform/errors/domain-error.js';
import { rawBodyOf } from '../../../../platform/http/raw-body-gate.js';
import { isValidSignature } from './webhook-signature.js';

/** The actor of `receiveGithubWebhook`: nobody is signed in, the signature over the raw body is the identity. */
export const GITHUB_SIGNATURE_ACTOR = 'github-signature';

/** Registers the actor policy of github. The worker has no routes, hence no `ActorPolicies`. */
@Injectable()
export class GithubOperations implements OnModuleInit {
  constructor(
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    @Optional() @Inject(ActorPolicies) private readonly policies?: ActorPolicies,
  ) {}

  onModuleInit(): void {
    if (this.policies === undefined || this.policies.get(GITHUB_SIGNATURE_ACTOR) !== undefined) {
      return;
    }
    this.policies.register(GITHUB_SIGNATURE_ACTOR, {
      requiresSession: false,
      check: ({ request }) => {
        const header = request.headers['x-hub-signature-256'];
        if (!isValidSignature(this.config.GITHUB_WEBHOOK_SECRET, rawBodyOf(request), header)) {
          throw new DomainError('SIGNATURE_INVALID', 401);
        }
      },
    });
  }
}
