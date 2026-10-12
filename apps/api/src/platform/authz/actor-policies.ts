import { Injectable } from '@nestjs/common';
import type { FastifyRequest } from 'fastify';
import type { XAuthz } from './contract-operations.js';

/** Resolves the signed-in user id of a request, or `undefined` when there is no valid session. */
export interface SessionAuthenticator {
  authenticate(request: FastifyRequest): Promise<string | undefined> | string | undefined;
}

/**
 * Provider token of the session authenticator. Slice 2 provides the Better Auth implementation;
 * until a provider exists, every operation that needs a session answers 401 (deny by default).
 * Tests provide a header-based stand-in from `test/support`, never `src/`.
 */
export const SESSION_AUTHENTICATOR = Symbol('SESSION_AUTHENTICATOR');

/** Provider token of the consent check (module auth); run by AuthzGuard for signed-in callers. */
export const CONSENT_GATE = Symbol('CONSENT_GATE');

export interface ConsentGate {
  /** Throws 403 CONSENT_REQUIRED when the user has not accepted the current consent text. */
  check(operationId: string, userId: string): Promise<void>;
}

export interface ActorContext {
  operationId: string;
  request: FastifyRequest;
  /** `x-authz` of the operation, including the `chain` of nested path identifiers. */
  authz: XAuthz;
  /** Present when the policy requires a session. */
  userId: string | undefined;
}

/**
 * Check for one `actor` value of `x-authz`. Slices 2-7 register the policies of `team-member`,
 * `team-lead`, `offer-party`, ... and verify `ctx.authz.chain` against the database; the mechanism
 * (every route has an operation, every operation an actor, every actor a policy) lives here.
 */
export interface ActorPolicy {
  /** The guard resolves the session first; no session -> 401 UNAUTHENTICATED. */
  requiresSession: boolean;
  check(ctx: ActorContext): Promise<void> | void;
}

/** Actors that need nothing beyond a session in slice 1. */
const SESSION_ONLY: ActorPolicy = { requiresSession: true, check: () => undefined };
const ANYONE: ActorPolicy = { requiresSession: false, check: () => undefined };

/** Registry of actor policies; extension point for the domain modules. */
@Injectable()
export class ActorPolicies {
  private readonly policies = new Map<string, ActorPolicy>([
    ['public', ANYONE],
    ['authenticated', SESSION_ONLY],
    // `self`: the user id comes from the session only, never from the request (13.14).
    ['self', SESSION_ONLY],
  ]);

  register(actor: string, policy: ActorPolicy): void {
    if (this.policies.has(actor)) throw new Error(`Actor policy "${actor}" is already registered`);
    this.policies.set(actor, policy);
  }

  get(actor: string): ActorPolicy | undefined {
    return this.policies.get(actor);
  }
}
