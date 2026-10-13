import { randomUUID } from 'node:crypto';
import { expect } from 'vitest';
import type { InjectResponse } from '../helpers/http.js';
import { barrier } from '../helpers/infra.js';
import { expectReplayed } from './assertions.js';

/** One request of a concurrent burst with the Idempotency-Key it was sent with. */
export interface Fired {
  index: number;
  key: string;
  response: InjectResponse;
  status: number;
  code: string | undefined;
}

/**
 * Releases `count` requests at the same moment (architecture 12.5: `barrier(N)` + `Promise.allSettled`).
 * Every request gets its own Idempotency-Key unless `keys` says otherwise. A request that throws
 * (transport error) fails the test: `inject` does not reject on HTTP errors.
 */
export async function fireAll(
  count: number,
  send: (index: number, key: string) => Promise<InjectResponse>,
  keys: string[] = Array.from({ length: count }, () => randomUUID()),
): Promise<Fired[]> {
  const gate = barrier(count);
  const settled = await Promise.allSettled(
    keys.map(async (key, index) => {
      await gate.wait();
      return send(index, key);
    }),
  );
  return settled.map((result, index) => {
    if (result.status === 'rejected') throw result.reason;
    const response = result.value;
    const code = response.statusCode >= 400 ? response.json<{ code?: string }>().code : undefined;
    return { index, key: keys[index] ?? '', response, status: response.statusCode, code };
  });
}

/** Status -> how many, e.g. `{ 200: 1, 409: 19 }`. */
export function tally(fired: Fired[]): Record<number, number> {
  const counts: Record<number, number> = {};
  for (const f of fired) counts[f.status] = (counts[f.status] ?? 0) + 1;
  return counts;
}

/** Distinct error codes of the responses with `status`, sorted. */
export function codesAt(fired: Fired[], status: number): string[] {
  const codes = fired.filter((f) => f.status === status).map((f) => f.code ?? '');
  return [...new Set(codes)].sort();
}

export function winnerOf(fired: Fired[], status: number): Fired {
  const winner = fired.find((f) => f.status === status);
  if (!winner)
    throw new Error(`no response with status ${status}: ${JSON.stringify(tally(fired))}`);
  return winner;
}

/**
 * The paired test of every CC scenario (plan, "Правила тестов"): the same request with the same key
 * returns the stored answer with `Idempotent-Replayed: true` and the same status and body.
 */
export function expectReplayOf(first: Fired, replay: InjectResponse): void {
  expect(replay.statusCode).toBe(first.status);
  expectReplayed(replay);
  if (first.response.body !== '') expect(replay.json()).toEqual(first.response.json());
}
