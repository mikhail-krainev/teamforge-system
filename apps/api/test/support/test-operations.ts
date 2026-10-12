import type { JsonSchema, OperationSpec } from '../../src/platform/authz/contract-operations.js';

const authenticated = { actor: 'authenticated' };

const string = (maxLength: number): JsonSchema => ({ type: 'string', minLength: 1, maxLength });

const echoBody: JsonSchema = {
  type: 'object',
  required: ['value'],
  additionalProperties: false,
  properties: {
    value: string(200),
    delayMs: { type: 'integer', minimum: 0, maximum: 5000 },
    fail: { enum: ['domain', 'internal', 'rate_limited', 'unavailable'] },
    attemptTimeoutMs: { type: 'integer', minimum: 50, maximum: 20_000 },
  },
};

const valueBody: JsonSchema = {
  type: 'object',
  required: ['value'],
  additionalProperties: false,
  properties: { value: string(200) },
};

const accountBody: JsonSchema = {
  type: 'object',
  required: ['email', 'token'],
  additionalProperties: false,
  properties: { email: string(200), token: string(200) },
};

const versionedBody: JsonSchema = {
  type: 'object',
  required: ['version', 'value'],
  additionalProperties: false,
  properties: { version: { type: 'integer', minimum: 1 }, value: string(200) },
};

const versionedParams: JsonSchema = {
  type: 'object',
  required: ['id'],
  properties: { id: { type: 'string', format: 'uuid' } },
};

function op(
  operationId: string,
  method: string,
  path: string,
  schemas: OperationSpec['schemas'] = {},
): OperationSpec {
  return { operationId, method, path, authz: authenticated, schemas };
}

/**
 * Operations of the test-support controller. They are not part of the public contract, so they
 * bring their own `x-authz` and request schemas to AuthzRegistry through EXTRA_OPERATIONS.
 */
export const TEST_OPERATIONS: OperationSpec[] = [
  op('testEcho', 'post', '/v1/_test/echo', { body: echoBody, bodyRequired: true }),
  op('testTwoTransactions', 'post', '/v1/_test/two-transactions', {
    body: valueBody,
    bodyRequired: true,
  }),
  op('testDto', 'post', '/v1/_test/dto', { body: valueBody, bodyRequired: true }),
  op('testLimitedWrite', 'post', '/v1/_test/limited-write', {
    body: valueBody,
    bodyRequired: true,
  }),
  op('testAccounts', 'post', '/v1/_test/accounts', { body: accountBody, bodyRequired: true }),
  op('testVersioned', 'put', '/v1/_test/versioned/{id}', {
    params: versionedParams,
    body: versionedBody,
    bodyRequired: true,
  }),
  op('testLimited', 'get', '/v1/_test/limited'),
  op('testIp', 'get', '/v1/_test/ip'),
];
