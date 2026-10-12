import type { components, operations, paths } from './generated/api.js';

export type { components, operations, paths };

/** Named schema from `components.schemas`. */
export type Schema<N extends keyof components['schemas']> = components['schemas'][N];

/** Error code enum from the contract (`ErrorCode` schema). */
export type ErrorCode = components['schemas']['ErrorCode'];

export type OperationId = keyof operations;

type JsonContent<T> = T extends { content: { 'application/json': infer J } } ? J : never;

/** JSON request body of an operation (never when the operation has no JSON body). */
export type Body<Op extends OperationId> = operations[Op] extends { requestBody?: infer R }
  ? JsonContent<NonNullable<R>>
  : never;

type SuccessStatus = 200 | 201 | 202 | 203 | 206;

/** JSON body of the successful (2xx with content) response of an operation. */
export type Ok<Op extends OperationId> = operations[Op] extends { responses: infer R }
  ? { [S in keyof R & SuccessStatus]: JsonContent<R[S]> }[keyof R & SuccessStatus]
  : never;

export * from './realtime.js';
