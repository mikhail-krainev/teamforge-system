import type { HttpAdapterHost } from '@nestjs/core';
import { describe, expect, it } from 'vitest';
import { RealtimeGateway } from './realtime.gateway.js';
import { WS_LIMITS } from './protocol.js';

function gatewayWith(host: unknown): RealtimeGateway {
  const none = undefined as never;
  return new RealtimeGateway(none, none, none, none, none, host as HttpAdapterHost);
}

describe('RealtimeGateway without an http server (the worker process)', () => {
  it('starts and stops when the http adapter is null (standalone application context)', async () => {
    const gateway = gatewayWith({ httpAdapter: null });
    await expect(gateway.onApplicationBootstrap()).resolves.toBeUndefined();
    await expect(gateway.onApplicationShutdown()).resolves.toBeUndefined();
  });

  it('starts when the http adapter host is absent', async () => {
    await expect(gatewayWith(undefined).onApplicationBootstrap()).resolves.toBeUndefined();
  });
});

interface FakeSocket {
  readyState: number;
  closedWith: number | undefined;
  send(): void;
  close(code?: number): void;
  terminate(): void;
  ping(): void;
  on(event: string, listener: () => void): void;
  emit(event: string): void;
}

function fakeSocket(): FakeSocket {
  const listeners = new Map<string, Array<() => void>>();
  const socket: FakeSocket = {
    readyState: 1,
    closedWith: undefined,
    send: () => undefined,
    close: (code) => {
      socket.closedWith = code;
      socket.readyState = 3;
    },
    terminate: () => undefined,
    ping: () => undefined,
    on: (event, listener) => listeners.set(event, [...(listeners.get(event) ?? []), listener]),
    emit: (event) => listeners.get(event)?.forEach((listener) => listener()),
  };
  return socket;
}

describe('RealtimeGateway connection limit (S3SEC-03)', () => {
  it('parallel handshakes of one user reserve their slot synchronously and never exceed the limit', async () => {
    const userId = '0194a000-0000-7000-8000-000000000001';
    const gateway = new RealtimeGateway(
      { APP_ORIGIN: 'https://app.example.test' } as never,
      { run: (fn: () => unknown) => fn() } as never,
      undefined as never,
      undefined as never,
      { hasValidConsent: () => Promise.resolve(true) } as never,
      undefined,
      { authenticate: () => Promise.resolve(userId) },
    );
    const request = { headers: { origin: 'https://app.example.test' }, ip: '127.0.0.1' };
    const sockets = Array.from({ length: 12 }, fakeSocket);
    const accept = (gateway as unknown as { accept(s: unknown, r: unknown): void }).accept.bind(
      gateway,
    );
    for (const socket of sockets) accept(socket, request);
    await new Promise((resolve) => setTimeout(resolve, 50));
    const open = sockets.filter((s) => s.closedWith === undefined);
    expect(open).toHaveLength(WS_LIMITS.maxConnectionsPerUser);
    expect(sockets.filter((s) => s.closedWith === 1013)).toHaveLength(
      sockets.length - WS_LIMITS.maxConnectionsPerUser,
    );
    // A slot is free again after a socket closed.
    open[0]?.emit('close');
    const late = fakeSocket();
    accept(late, request);
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(late.closedWith).toBeUndefined();
  });
});
