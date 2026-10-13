import { hmacBytes } from '../../../../platform/crypto/secret-box.js';
import { AUTH_MODULE } from '../../public.js';

/**
 * Outbox event written in the transaction of `requestDeletion` (S2CR-02). It carries ids only; its
 * consumers send the confirmation mail and revoke the sessions, each with its own retries.
 */
export const DELETION_REQUEST_CREATED_TYPE = 'deletion_request_created' as const;
export const DELETION_REQUEST_CREATED = `${AUTH_MODULE}.${DELETION_REQUEST_CREATED_TYPE}` as const;

/**
 * The one-time cancel token of a request. It is derived from the request id and `IP_HASH_SALT`
 * instead of being random, so the mail consumer can rebuild the link after the request commits
 * without the token ever being stored or put into an event; the table keeps only its SHA-256.
 */
export function cancelTokenFor(salt: string, requestId: string): string {
  return hmacBytes(salt, `deletion-cancel-token:${requestId}`).toString('base64url');
}
