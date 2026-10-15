import type { ErrorCode } from 'shared';

export type { ErrorCode };

/** A violation with a JSON pointer, as carried by `DomainError.data.errors`. */
export interface FieldErrorLike {
  pointer: string;
  code: string;
  message: string;
}
