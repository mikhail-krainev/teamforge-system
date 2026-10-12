import { SetMetadata } from '@nestjs/common';

export const OPERATION_KEY = 'tf:operation';
export const NO_IDEMPOTENCY_KEY = 'tf:no-idempotency';

/** Binds a handler to its OpenAPI operationId. Required on every handler of /v1 routes. */
export const Operation = (operationId: string): MethodDecorator =>
  SetMetadata(OPERATION_KEY, operationId);

/** Excludes a mutating operation from Idempotency-Key handling (architecture 14 exceptions). */
export const NoIdempotency = (): MethodDecorator => SetMetadata(NO_IDEMPOTENCY_KEY, true);
