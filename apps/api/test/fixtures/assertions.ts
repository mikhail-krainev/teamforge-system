import { createHash } from 'node:crypto';
import { expect } from 'vitest';
import { expectMatchesContract } from '../helpers/contract.js';
import type { InjectResponse } from '../helpers/http.js';

export interface ProblemBody {
  type: string;
  title: string;
  status: number;
  code: string;
  requestId: string;
  errors?: { pointer: string; code?: string; message: string }[];
  current?: Record<string, unknown>;
  retryAfterSeconds?: number;
}

/**
 * A problem+json answer (docs/architecture.md 13.1): the status, the machine code and, unless the
 * contract does not declare that status for the operation, the schema of the operation.
 */
export function expectProblem(
  operationId: string | null,
  response: InjectResponse,
  status: number,
  code: string,
): ProblemBody {
  expect(response.statusCode, `${operationId ?? 'request'}: ${response.body}`).toBe(status);
  expect(String(response.headers['content-type'])).toContain('application/problem+json');
  if (operationId) expectMatchesContract(operationId, response);
  const body = response.json<ProblemBody>();
  expect(body.code).toBe(code);
  return body;
}

/** The stored answer of a repeated request with the same Idempotency-Key (architecture 12.4). */
export function expectReplayed(response: InjectResponse): void {
  expect(response.headers['idempotent-replayed']).toBe('true');
}

export function expectRateLimited(operationId: string | null, response: InjectResponse): void {
  const body = expectProblem(operationId, response, 429, 'RATE_LIMITED');
  expect(Number(response.headers['retry-after'])).toBeGreaterThanOrEqual(1);
  expect(body.status).toBe(429);
}

export const sha256Hex = (text: string): string => createHash('sha256').update(text).digest('hex');

/** Application log lines that contain `needle` (secrets must never appear in logs, SEC-07). */
export function logLinesWith(logs: string[], needle: string): string[] {
  return logs.filter((line) => line.includes(needle));
}

/** Time in ms between two ISO timestamps. */
export const gapMs = (from: string, to: string): number => Date.parse(to) - Date.parse(from);

/** The `n` column of the first row of a `SELECT count(*)::int AS n ...` query. */
export async function countOf(rows: PromiseLike<{ n: number }[]>): Promise<number> {
  return (await rows)[0]?.n ?? Number.NaN;
}
