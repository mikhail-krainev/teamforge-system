import type { QueueName } from '../../../../platform/queues/queue-definitions.js';

export const WEBHOOK_QUEUE: QueueName = 'github-webhook';
export const WEBHOOK_JOB = 'process-delivery';

/** Events and actions the worker does something with; any other delivery is stored as ignored (SEC-06). */
const HANDLED_ACTIONS: Readonly<Record<string, ReadonlySet<string>>> = {
  issues: new Set([
    'opened',
    'edited',
    'closed',
    'reopened',
    'assigned',
    'unassigned',
    'labeled',
    'unlabeled',
  ]),
  pull_request: new Set([
    'opened',
    'edited',
    'closed',
    'reopened',
    'synchronize',
    'assigned',
    'unassigned',
    'labeled',
    'unlabeled',
    'ready_for_review',
    'converted_to_draft',
  ]),
  pull_request_review: new Set(['submitted', 'edited', 'dismissed']),
  installation: new Set(['deleted', 'suspend', 'unsuspend']),
  installation_repositories: new Set(['removed']),
  repository: new Set(['archived', 'deleted', 'privatized', 'renamed', 'transferred']),
};

export function isHandledEvent(event: string, action: string | null): boolean {
  return action !== null && (HANDLED_ACTIONS[event]?.has(action) ?? false);
}
