import type { ServerErrorMessage } from 'shared/realtime';

/**
 * Wire constants of the WebSocket protocol (architecture 9), mirrored from `shared/realtime`.
 * The api must not import runtime values from `shared`: the package ships TypeScript sources, and
 * Node refuses to strip types under node_modules, so the production image would not start.
 * `protocol.test.ts` fails when the two copies drift apart.
 */
export const WS_CLOSE_UNAUTHENTICATED = 4401;
export const WS_CLOSE_FORBIDDEN = 4403;

export const WS_LIMITS = {
  pingIntervalMs: 25_000,
  idleTimeoutMs: 60_000,
  maxConnectionsPerUser: 5,
  maxSubscriptionsPerConnection: 50,
  maxClientMessagesPer10s: 20,
} as const;

export type { ServerErrorMessage };
