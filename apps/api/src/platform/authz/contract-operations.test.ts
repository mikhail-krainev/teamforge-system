import { describe, expect, it } from 'vitest';
import { toContractPath } from './authz.registry.js';
import {
  loadContractDocument,
  readContractOperations,
  rewriteRefs,
} from './contract-operations.js';
import { OperationValidators } from './operation-validators.js';

const doc = loadContractDocument();
const operations = readContractOperations(doc);

describe('contract operations (packages/shared/openapi.json)', () => {
  it('reads every operation with its x-authz', () => {
    expect(operations.size).toBe(115);
    expect([...operations.values()].filter((o) => o.authz === undefined)).toEqual([]);
    expect(operations.get('healthLive')).toMatchObject({
      method: 'get',
      path: '/health/live',
      authz: { actor: 'public' },
    });
    expect(operations.get('healthReady')?.authz).toEqual({ actor: 'public' });
  });

  it('compiles the request schemas of ALL operations at once (refs resolve, formats known)', () => {
    expect(() => new OperationValidators(doc, operations.values())).not.toThrow();
  });

  it('validates path, query and body of real operations', () => {
    const validators = new OperationValidators(doc, operations.values());
    const parts = (params: unknown, query: unknown, body: unknown) => ({ params, query, body });
    expect(validators.validate('getTeam', parts({ teamId: 'nope' }, {}, undefined))).toEqual([
      expect.objectContaining({ pointer: '/params/teamId', code: 'format' }),
    ]);
    const query = { limit: '500', prefix: 'ab' };
    expect(validators.validate('listStackTags', parts({}, query, undefined))).toEqual([
      expect.objectContaining({ pointer: '/query/limit', code: 'maximum' }),
    ]);
    const good = { version: 'v1', textHash: 'a'.repeat(64) };
    expect(validators.validate('acceptConsent', parts({}, {}, good))).toEqual([]);
    // An unknown field is refused, not removed in silence (architecture 13.3).
    const extra = { ...good, unknown: 'kept' };
    expect(validators.validate('acceptConsent', parts({}, {}, extra))).toEqual([
      expect.objectContaining({ pointer: '/', code: 'additionalProperties' }),
    ]);
    expect(extra).toEqual({ ...good, unknown: 'kept' });
    const bad = validators.validate('acceptConsent', parts({}, {}, { version: 'v1' }));
    expect(bad).toEqual([expect.objectContaining({ pointer: '/textHash', code: 'required' })]);
  });
});

describe('helpers', () => {
  it('rewrites local refs into the registered document', () => {
    expect(
      rewriteRefs({ a: [{ $ref: '#/components/schemas/X' }], b: { $ref: 'other#/x' } }),
    ).toEqual({
      a: [{ $ref: 'openapi#/components/schemas/X' }],
      b: { $ref: 'other#/x' },
    });
  });

  it('converts Nest paths to the notation of the contract', () => {
    expect(toContractPath('v1/teams', ':teamId/seats/:seatId')).toBe(
      '/v1/teams/{teamId}/seats/{seatId}',
    );
    expect(toContractPath('health', '/')).toBe('/health');
    expect(toContractPath('', 'live')).toBe('/live');
  });
});
