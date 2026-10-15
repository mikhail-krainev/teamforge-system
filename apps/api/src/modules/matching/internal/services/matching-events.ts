import type { NewOutboxEvent } from '../../../../platform/outbox/outbox.types.js';
import { MATCHING_MODULE, type ApplicationChangedPayload } from '../../public.js';

/** Outbox event of the matching module. */
export function matchingEvent(
  type: string,
  aggregateId: string,
  payload: Record<string, unknown>,
): NewOutboxEvent {
  return { module: MATCHING_MODULE, type, aggregateId, payload };
}

/** `matching.application_changed {userId, applicationId, status}`; the aggregate is the application. */
export function applicationChanged(payload: ApplicationChangedPayload): NewOutboxEvent {
  return matchingEvent('application_changed', payload.applicationId, { ...payload });
}
