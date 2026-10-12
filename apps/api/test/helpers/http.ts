import { randomUUID } from 'node:crypto';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';

export type InjectResponse = Awaited<ReturnType<NestFastifyApplication['inject']>>;

export interface CallOptions {
  user?: string;
  /** Idempotency-Key header; a random one by default, `null` omits the header. */
  key?: string | null;
}

/** POST/PUT helper for the test-support endpoints. */
export function call(
  app: NestFastifyApplication,
  method: 'POST' | 'PUT' | 'GET',
  url: string,
  payload: unknown,
  options: CallOptions = {},
): Promise<InjectResponse> {
  const headers: Record<string, string> = { 'x-test-user': options.user ?? randomUUID() };
  if (options.key !== null) headers['idempotency-key'] = options.key ?? randomUUID();
  return app.inject({
    method,
    url: `/api${url}`,
    headers,
    ...(payload === undefined ? {} : { payload: payload as Record<string, unknown> }),
  });
}

export function statuses(results: PromiseSettledResult<InjectResponse>[]): Record<number, number> {
  const counts: Record<number, number> = {};
  for (const result of results) {
    const status = result.status === 'fulfilled' ? result.value.statusCode : 0;
    counts[status] = (counts[status] ?? 0) + 1;
  }
  return counts;
}

export function codes(results: PromiseSettledResult<InjectResponse>[], status: number): string[] {
  return results
    .flatMap((r) => (r.status === 'fulfilled' && r.value.statusCode === status ? [r.value] : []))
    .map((r) => r.json<{ code: string }>().code);
}
