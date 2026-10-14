import type { HttpAdapterHost } from '@nestjs/core';
import { describe, expect, it } from 'vitest';
import { RealtimeGateway } from './realtime.gateway.js';

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
