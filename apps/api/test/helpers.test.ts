import { describe, expect, it } from 'vitest';
import { idorMatrix } from './helpers/authz.js';
import { FakeClock } from './helpers/clock.js';
import { allOperations, expectMatchesContract, findOperation } from './helpers/contract.js';
import { uuidFor, user } from './fixtures/index.js';

const jsonResponse = (statusCode: number, body: unknown) => ({
  statusCode,
  headers: { 'content-type': 'application/json; charset=utf-8' },
  body: JSON.stringify(body),
  json: () => body,
});

describe('S1-10 test infrastructure: contract helper', () => {
  it('knows all 114 operations of the contract', () => {
    expect(allOperations()).toHaveLength(114);
    expect(() => findOperation('noSuchOperation')).toThrow(/Unknown operationId/);
  });

  it('accepts a Health body declared for healthReady', () => {
    const body = { status: 'ok', checks: { postgres: { status: 'ok', latencyMs: 3 } } };
    expect(() => expectMatchesContract('healthReady', jsonResponse(200, body))).not.toThrow();
  });

  it('rejects a body that violates the schema and a status the contract does not declare', () => {
    expect(() =>
      expectMatchesContract('healthReady', jsonResponse(200, { status: 'fine' })),
    ).toThrow(/violates the contract/);
    expect(() => expectMatchesContract('healthReady', jsonResponse(418, {}))).toThrow(
      /not declared/,
    );
  });
});

describe('S1-10 test infrastructure: idorMatrix from x-authz', () => {
  it('derives no negative cases for public operations', () => {
    expect(idorMatrix('healthLive').cases).toEqual([]);
  });

  it('derives outsider, nested-id, role and anonymous cases for a team-lead operation', () => {
    const lead = allOperations().find(
      (op) =>
        op.operation['x-authz']?.actor === 'team-lead' &&
        (op.operation['x-authz'].chain?.length ?? 0) >= 2,
    );
    expect(lead, 'the contract has a team-lead operation with a chain of 2+').toBeDefined();
    const matrix = idorMatrix(lead?.operationId ?? '');
    const kinds = new Set(matrix.cases.map((c) => c.kind));
    expect(kinds).toEqual(new Set(['anonymous', 'outsider', 'swapped-id', 'low-role']));
    expect(matrix.cases.find((c) => c.kind === 'swapped-id')?.expectedStatus).toBe(404);
    expect(matrix.cases.find((c) => c.kind === 'low-role')?.expectedStatus).toBe(403);
  });

  it('builds a matrix for every operation and always requires a session unless public', () => {
    for (const { operationId, operation } of allOperations()) {
      const matrix = idorMatrix(operationId);
      const actor = operation['x-authz']?.actor ?? '';
      const needsSession = !['public', 'github-signature'].includes(actor);
      expect(
        matrix.cases.some((c) => c.kind === 'anonymous'),
        operationId,
      ).toBe(needsSession);
    }
  });
});

describe('S1-10 test infrastructure: clock and fixtures', () => {
  it('FakeClock moves only when told to', () => {
    const clock = new FakeClock('2026-03-01T00:00:00.000Z');
    expect(clock.now().toISOString()).toBe('2026-03-01T00:00:00.000Z');
    clock.advance(72 * 3_600_000);
    expect(clock.now().toISOString()).toBe('2026-03-04T00:00:00.000Z');
  });

  it('fixtures are deterministic and UUID-shaped', () => {
    expect(uuidFor('a')).toBe(uuidFor('a'));
    expect(uuidFor('a')).not.toBe(uuidFor('b'));
    expect(uuidFor('a')).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
    expect(user('x').id).toBe(user('x').id);
  });
});
