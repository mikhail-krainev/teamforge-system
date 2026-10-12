import { uuidv7 } from 'uuidv7';

const REQUEST_ID_PATTERN = /^[A-Za-z0-9._-]{8,64}$/;

export function newRequestId(): string {
  return uuidv7();
}

/** Uses the client X-Request-Id when its format is valid, otherwise generates a UUID v7. */
export function resolveRequestId(header: string | string[] | undefined): string {
  const candidate = Array.isArray(header) ? header[0] : header;
  return candidate !== undefined && REQUEST_ID_PATTERN.test(candidate) ? candidate : newRequestId();
}
