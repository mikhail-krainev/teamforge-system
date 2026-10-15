import {
  Inject,
  Injectable,
  Optional,
  type OnApplicationBootstrap,
  type OnApplicationShutdown,
} from '@nestjs/common';
import { HttpAdapterHost } from '@nestjs/core';
import websocket from '@fastify/websocket';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { Redis } from 'ioredis';
import { ClsService } from 'nestjs-cls';
import {
  SESSION_AUTHENTICATOR,
  type SessionAuthenticator,
} from '../../../../platform/authz/actor-policies.js';
import { APP_CONFIG } from '../../../../platform/config/config.module.js';
import type { AppConfig } from '../../../../platform/config/config.js';
import { DomainError } from '../../../../platform/errors/domain-error.js';
import { API_PREFIX } from '../../../../platform/http/fastify.js';
import { REDIS } from '../../../../platform/redis/redis.module.js';
import { AUTH_API, type AuthApi } from '../../../auth/public.js';
import { TEAMS_API, type TeamsApi } from '../../../teams/public.js';
import { REALTIME_PREFIX } from '../events/realtime-relay.consumer.js';
import { ChannelRegistry, type RealtimeConnection } from './channel-registry.js';
import {
  WS_CLOSE_FORBIDDEN,
  WS_CLOSE_UNAUTHENTICATED,
  WS_LIMITS,
  type ServerErrorMessage,
} from './protocol.js';

/** The part of a `ws` socket this gateway uses (the `ws` types are not a dependency of the api). */
interface SocketLike {
  readyState: number;
  send(data: string): void;
  close(code?: number): void;
  terminate(): void;
  ping(): void;
  on(event: 'message', listener: (data: Buffer) => void): void;
  on(event: 'pong' | 'close' | 'error', listener: () => void): void;
}

const SOCKET_OPEN = 1;
const CLOSE_POLICY = 1008;
const CLOSE_TRY_AGAIN = 1013;
const CLOSE_GOING_AWAY = 1001;
const MAX_MESSAGE_BYTES = 1024;
const RATE_WINDOW_MS = 10_000;
const MEMBERSHIP_RECHECK_MS = 5 * 60_000;
const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
const CHANNEL = new RegExp(`^(user|team):(${UUID})$`, 'i');

function errorMessage(code: string): string {
  const message: ServerErrorMessage = { op: 'error', code };
  return JSON.stringify(message);
}

/**
 * WebSocket `/api/ws` of the api process (architecture 9, ADR-0011). The handshake is accepted
 * and then judged: no session -> close 4401, wrong Origin or no consent -> 4403. `user:<own id>`
 * is joined automatically, `team:<id>` only after `TeamsApi.assertMember`. Messages arrive from
 * the outbox relay through Redis `PSUBSCRIBE rt:*` and carry no data beyond ids and statuses.
 * The worker has no HTTP server and so no gateway.
 */
@Injectable()
export class RealtimeGateway implements OnApplicationBootstrap, OnApplicationShutdown {
  private readonly registry = new ChannelRegistry();
  private subscriber: Redis | undefined;
  private timer: NodeJS.Timeout | undefined;
  private readonly seen = new WeakMap<RealtimeConnection, { at: number; checked: number }>();
  /** Slots taken by handshakes that passed the limit check but are not in the registry yet (S3SEC-03). */
  private readonly reserved = new Map<string, number>();

  constructor(
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    @Inject(ClsService) private readonly cls: ClsService,
    @Inject(REDIS) private readonly redis: Redis,
    @Inject(TEAMS_API) private readonly teams: TeamsApi,
    @Inject(AUTH_API) private readonly auth: AuthApi,
    @Optional() @Inject(HttpAdapterHost) private readonly host?: HttpAdapterHost,
    @Optional()
    @Inject(SESSION_AUTHENTICATOR)
    private readonly authenticator?: SessionAuthenticator,
  ) {}

  /**
   * Bootstrap, not module init: awaiting `register` makes Fastify finalize the routes added so far,
   * and Nest installs its error handler (the problem+json filter) only after the module init hooks.
   * Registering earlier would leave every route with Fastify's default error handler.
   */
  async onApplicationBootstrap(): Promise<void> {
    const adapter = this.host?.httpAdapter;
    // A standalone application context (the worker) has no http adapter: `null` there, not undefined.
    if (!adapter) return;
    const fastify = adapter.getInstance<FastifyInstance>();
    await fastify.register(websocket, { options: { maxPayload: MAX_MESSAGE_BYTES } });
    await fastify.register((scope, _options, done) => {
      scope.get(`/${API_PREFIX}/ws`, { websocket: true }, (socket, request) => {
        this.accept(socket as unknown as SocketLike, request);
      });
      done();
    });
    // Redis being down must not stop the api from starting (/health/ready reports it): the
    // subscriber waits for the connection (no per-request retry limit) and subscribes then.
    this.subscriber = this.redis.duplicate({ maxRetriesPerRequest: null });
    this.subscriber.on('error', () => undefined);
    this.subscriber.on('pmessage', (_pattern, channel, text) => this.relay(channel, text));
    void this.subscriber.psubscribe(`${REALTIME_PREFIX}*`).catch(() => undefined);
    this.timer = setInterval(() => this.heartbeat(), WS_LIMITS.pingIntervalMs);
    this.timer.unref();
  }

  async onApplicationShutdown(): Promise<void> {
    if (this.timer !== undefined) clearInterval(this.timer);
    for (const connection of this.registry.all()) connection.close(CLOSE_GOING_AWAY);
    const subscriber = this.subscriber;
    if (subscriber === undefined) return;
    // `quit` would wait for a connection that never comes when Redis is down.
    if (subscriber.status === 'ready') await subscriber.quit().catch(() => undefined);
    else subscriber.disconnect();
  }

  // ---- connection -------------------------------------------------------------------------

  private accept(socket: SocketLike, request: FastifyRequest): void {
    let connection: RealtimeConnection | undefined;
    let closed = false;
    const rate: number[] = [];
    // One chain per socket: the handshake first, then every message in arrival order.
    let chain: Promise<void> = this.cls
      .run(() => this.handshake(socket, request))
      .then((accepted) => {
        if (accepted === undefined) return;
        // The reservation turns into a registry entry (or is dropped) in one synchronous step.
        this.release(accepted.userId);
        if (closed) return;
        connection = accepted;
        this.registry.add(accepted);
        this.touch(accepted);
      })
      .catch(() => socket.close(CLOSE_TRY_AGAIN));
    socket.on('error', () => undefined);
    socket.on('close', () => {
      closed = true;
      if (connection !== undefined) this.registry.remove(connection);
    });
    socket.on('pong', () => this.touch(connection));
    socket.on('message', (data) => {
      const now = Date.now();
      while (rate.length > 0 && now - (rate[0] ?? now) > RATE_WINDOW_MS) rate.shift();
      rate.push(now);
      if (rate.length > WS_LIMITS.maxClientMessagesPer10s) {
        socket.close(CLOSE_POLICY);
        return;
      }
      chain = chain
        .then(async () => {
          if (connection === undefined || closed) return;
          this.touch(connection);
          await this.onMessage(connection, data);
        })
        .catch(() => undefined);
    });
  }

  /** Returns the connection, or closes the socket and returns `undefined`. */
  private async handshake(
    socket: SocketLike,
    request: FastifyRequest,
  ): Promise<RealtimeConnection | undefined> {
    const origin = request.headers.origin;
    if (origin === undefined || !this.originAllowed(origin)) {
      socket.close(WS_CLOSE_FORBIDDEN);
      return undefined;
    }
    const userId = await this.authenticator?.authenticate(request);
    if (userId === undefined) {
      socket.close(WS_CLOSE_UNAUTHENTICATED);
      return undefined;
    }
    if (!(await this.auth.hasValidConsent(userId))) {
      socket.close(WS_CLOSE_FORBIDDEN);
      return undefined;
    }
    // No `await` between the limit check and the reservation: parallel handshakes of one user
    // cannot all pass the check and then all join the registry.
    if (!this.reserve(userId)) {
      socket.close(CLOSE_TRY_AGAIN);
      return undefined;
    }
    // Only what the session lookup reads is kept (cookie headers, client address), not the request.
    const probe = { headers: request.headers, ip: request.ip } as unknown as FastifyRequest;
    return {
      userId,
      channels: new Set<string>(),
      send: (text) => {
        if (socket.readyState === SOCKET_OPEN) socket.send(text);
      },
      close: (code) => socket.close(code),
      ping: () => socket.ping(),
      isOpen: () => socket.readyState === SOCKET_OPEN,
      verifySession: async () =>
        (await this.cls.run(async () => this.authenticator?.authenticate(probe))) === userId,
    };
  }

  /** Takes a connection slot for `userId` synchronously; false when the user is at the limit. */
  private reserve(userId: string): boolean {
    const taken = this.registry.connectionsOf(userId).length + (this.reserved.get(userId) ?? 0);
    if (taken >= WS_LIMITS.maxConnectionsPerUser) return false;
    this.reserved.set(userId, (this.reserved.get(userId) ?? 0) + 1);
    return true;
  }

  private release(userId: string): void {
    const left = (this.reserved.get(userId) ?? 0) - 1;
    if (left > 0) this.reserved.set(userId, left);
    else this.reserved.delete(userId);
  }

  private originAllowed(origin: string): boolean {
    try {
      return new URL(origin).origin === new URL(this.config.APP_ORIGIN).origin;
    } catch {
      return false;
    }
  }

  private touch(connection: RealtimeConnection | undefined): void {
    if (connection === undefined) return;
    const state = this.seen.get(connection);
    this.seen.set(connection, { at: Date.now(), checked: state?.checked ?? Date.now() });
  }

  // ---- client messages --------------------------------------------------------------------

  private async onMessage(connection: RealtimeConnection, data: Buffer): Promise<void> {
    const parsed = this.parse(data);
    if (parsed === undefined) {
      connection.send(errorMessage('BAD_REQUEST'));
      return;
    }
    const { op, channel } = parsed;
    if (op === 'unsubscribe') {
      // The own user channel stays: it is not a subscription.
      if (channel !== `user:${connection.userId}`) this.registry.unsubscribe(connection, channel);
      return;
    }
    if (connection.channels.has(channel)) return;
    if (connection.channels.size >= WS_LIMITS.maxSubscriptionsPerConnection) {
      connection.send(errorMessage('TOO_MANY_SUBSCRIPTIONS'));
      return;
    }
    if (!(await this.mayJoin(connection.userId, channel))) {
      connection.send(errorMessage('FORBIDDEN'));
      return;
    }
    // The socket may have closed while membership was checked; its registry entry is gone then and
    // a late subscribe would leave a dead connection in the channel map (S3SEC-03).
    if (!connection.isOpen()) return;
    this.registry.subscribe(connection, channel);
  }

  private parse(data: Buffer): { op: 'subscribe' | 'unsubscribe'; channel: string } | undefined {
    let message: unknown;
    try {
      message = JSON.parse(data.toString('utf8'));
    } catch {
      return undefined;
    }
    if (typeof message !== 'object' || message === null) return undefined;
    const { op, channel } = message as Record<string, unknown>;
    if (op !== 'subscribe' && op !== 'unsubscribe') return undefined;
    if (typeof channel !== 'string' || !CHANNEL.test(channel)) return undefined;
    return { op, channel: channel.toLowerCase() };
  }

  /** `user:` is the own channel only; `team:` needs an active membership right now. */
  private async mayJoin(userId: string, channel: string): Promise<boolean> {
    const match = CHANNEL.exec(channel);
    const kind = match?.[1];
    const id = match?.[2];
    if (kind === undefined || id === undefined) return false;
    if (kind === 'user') return id === userId;
    try {
      await this.cls.run(() => this.teams.assertMember(id, userId));
      return true;
    } catch (error) {
      if (error instanceof DomainError) return false;
      throw error;
    }
  }

  // ---- Redis -> sockets -------------------------------------------------------------------

  private relay(redisChannel: string, text: string): void {
    const channel = redisChannel.slice(REALTIME_PREFIX.length);
    this.registry.deliver(channel, text);
    let type: string | undefined;
    let data: Record<string, unknown> | undefined;
    try {
      const message = JSON.parse(text) as { type?: string; data?: Record<string, unknown> };
      type = message.type;
      data = message.data;
    } catch {
      return;
    }
    const userId = data?.['userId'];
    if (type === 'member.left' && typeof userId === 'string') {
      // The signal reached the leaver first; after it the team channel is closed to him.
      this.registry.revoke(channel, userId);
    }
    if (type === 'session.revoked' && channel.startsWith('user:')) {
      // One session of the user may be gone (sign-out) while the others live: close only the
      // sockets whose own session no longer holds (S3SEC-01).
      for (const connection of this.registry.connectionsOf(channel.slice('user:'.length))) {
        void this.checkSession(connection, true);
      }
    }
  }

  // ---- keep-alive -------------------------------------------------------------------------

  private heartbeat(): void {
    const now = Date.now();
    for (const connection of this.registry.all()) {
      const state = this.seen.get(connection);
      if (state !== undefined && now - state.at > WS_LIMITS.idleTimeoutMs) {
        connection.close(CLOSE_GOING_AWAY);
        continue;
      }
      connection.ping();
      if (state !== undefined && now - state.checked >= MEMBERSHIP_RECHECK_MS) {
        this.seen.set(connection, { ...state, checked: now });
        void this.recheck(connection);
      }
    }
  }

  /**
   * Closes the socket with 4401 when its session is gone. A failed check leaves the socket open;
   * with `retrySoon` the next heartbeat repeats it instead of waiting for the regular interval.
   * Returns false when the socket was closed.
   */
  private async checkSession(connection: RealtimeConnection, retrySoon = false): Promise<boolean> {
    try {
      if (await connection.verifySession()) return true;
    } catch {
      const state = this.seen.get(connection);
      if (retrySoon && state !== undefined) this.seen.set(connection, { ...state, checked: 0 });
      return true;
    }
    connection.close(WS_CLOSE_UNAUTHENTICATED);
    return false;
  }

  /**
   * Long-lived sockets are judged again every few minutes: a session that ended without a signal
   * closes the socket (4401), and team channels whose membership has ended are dropped.
   */
  private async recheck(connection: RealtimeConnection): Promise<void> {
    if (!(await this.checkSession(connection))) return;
    for (const channel of [...connection.channels]) {
      if (!channel.startsWith('team:')) continue;
      try {
        if (!(await this.mayJoin(connection.userId, channel))) {
          this.registry.unsubscribe(connection, channel);
        }
      } catch {
        // A failed check is retried at the next round; the socket keeps its channel until then.
      }
    }
  }
}
