import { SetMetadata } from '@nestjs/common';

export const OPERATION_KEY = 'tf:operation';
export const NO_IDEMPOTENCY_KEY = 'tf:no-idempotency';

/**
 * Binds a route handler to its OpenAPI `operationId` and, through it, to the `x-authz` of that
 * operation (architecture 13.14, SEC-03). Required on EVERY route handler: AuthzRegistry refuses to
 * start the application for a route without it, and the global AuthzGuard denies it at runtime.
 * The same id selects the request schema for ValidationGuard (13.3).
 */
export const Authz = (operationId: string): MethodDecorator =>
  SetMetadata(OPERATION_KEY, operationId);

/** Excludes a mutating operation from Idempotency-Key handling (architecture 14 exceptions). */
export const NoIdempotency = (): MethodDecorator => SetMetadata(NO_IDEMPOTENCY_KEY, true);
