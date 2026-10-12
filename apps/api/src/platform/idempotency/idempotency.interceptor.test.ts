import { describe, expect, it } from 'vitest';
import { InvariantError } from '../errors/domain-error.js';
import { NO_IDEMPOTENCY_KEY, OPERATION_KEY } from '../http/operation.decorator.js';
import { IdempotencyInterceptor } from './idempotency.interceptor.js';

function build(options: { actor?: string; noIdempotency?: boolean; userId?: string }) {
  const metadata: Record<string, unknown> = {
    [OPERATION_KEY]: 'someOperation',
    [NO_IDEMPOTENCY_KEY]: options.noIdempotency,
  };
  const reflector = { get: (key: string) => metadata[key] };
  const registry = {
    get: () => (options.actor === undefined ? undefined : { authz: { actor: options.actor } }),
  };
  const cls = { get: () => options.userId, set: () => undefined };
  const interceptor = new IdempotencyInterceptor(
    reflector as never,
    cls as never,
    {} as never,
    registry as never,
  );
  const context = {
    getType: () => 'http',
    getHandler: () => function createSomething() {},
    switchToHttp: () => ({ getRequest: () => ({ method: 'POST', headers: {} }) }),
  };
  const handled = { handle: () => 'handled' };
  return { run: () => interceptor.intercept(context as never, handled as never) };
}

describe('IdempotencyInterceptor without a signed-in user (S1R-06: fail closed)', () => {
  it('refuses a mutating handler that runs without a user and is neither public nor excluded', () => {
    expect(() => build({ actor: 'authenticated' }).run()).toThrow(InvariantError);
    expect(() => build({ actor: 'invitee' }).run()).toThrow(/NoIdempotency|public/);
    expect(() => build({}).run()).toThrow(InvariantError);
  });

  it('lets a public operation through (no user, no idempotency scope)', () => {
    expect(build({ actor: 'public' }).run()).toBe('handled');
  });

  it('lets an explicit @NoIdempotency() operation through', () => {
    expect(build({ actor: 'github-signature', noIdempotency: true }).run()).toBe('handled');
  });
});
