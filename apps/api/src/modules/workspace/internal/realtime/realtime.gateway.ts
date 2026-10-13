import {
  Inject,
  Injectable,
  Optional,
  type OnApplicationShutdown,
  type OnModuleInit,
} from '@nestjs/common';
import { HttpAdapterHost } from '@nestjs/core';
import websocket from '@fastify/websocket';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { Redis } from 'ioredis';
import { ClsService } from 'nestjs-cls';
import {
  WS_CLOSE_FORBIDDEN,
  WS_CLOSE_UNAUTHENTICATED,
  WS_LIMITS,
  type ServerErrorMessage,
} from 'shared/realtime';
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
export class RealtimeGateway implements OnModuleInit, OnApplicationShutdown {
  private readonly registry = new ChannelRegistry();
  private subscriber: Redis | undefined;
  private timer: NodeJS.Timeout | undefined;
  private readonly seen = new WeakMap<RealtimeConnection, { at: number; checked: number }>();

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

  async onModuleInit(): Promise<void> {
    const adapter = this.host?.httpAdapter;
    if (adapter === undefined) return;
    const fastify = adapter.getInstance<FastifyInstance>();
    await fastify.register(websocket, { options: { maxPayload: MAX_MESSAGE_BYTES } });
    await fastify.register((scope, _options, done) => {
      scope.get(`/${API_PREFIX}/ws`, { websocket: true }, (socket, request) => {
        this.accept(socket as unknown as SocketLike, request);
      });
      done();
    });
    this.subscriber = this.redis.duplicate();
    this.subscriber.on('error', () => undefined);
    this.subscriber.on('pmessage', (_pattern, channel, text) => this.relay(channel, text));
    await this.subscriber.psubscribe(`${REALTIME_PREFIX}*`);
    this.timer = setInterval(() => this.heartbeat(), WS_LIMITS.pingIntervalMs);
    this.timer.unref();
  }

  async onApplicationShutdown(): Promise<void> {
    if (this.timer !== undefined) clearInterval(this.timer);
    for (const connection of this.registry.all()) connection.close(CLOSE_GOING_AWAY);
    await this.subscriber?.quit().catch(() => undefined);
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
        if (accepted === undefined || closed) return;
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
    if (this.registry.connectionsOf(userId).length >= WS_LIMITS.maxConnectionsPerUser) {
      socket.close(CLOSE_TRY_AGAIN);
      return undefined;
    }
    return {
      userId,
      channels: new Set<string>(),
      send: (text) => {
        if (socket.readyState === SOCKET_OPEN) socket.send(text);
      },
      close: (code) => socket.close(code),
      ping: () => socket.ping(),
    };
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
      for (const connection of this.registry.connectionsOf(channel.slice('user:'.length))) {
        connection.close(WS_CLOSE_UNAUTHENTICATED);
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

  /** Long-lived sockets lose the team channels whose membership has ended meanwhile. */
  private async recheck(connection: RealtimeConnection): Promise<void> {
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
