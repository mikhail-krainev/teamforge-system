import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Ajv2020 } from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
import { expect } from 'vitest';

/** The bundled contract that `pnpm --filter shared run generate` writes (docs/api/openapi.yaml). */
const CONTRACT_PATH = resolve(
  fileURLToPath(new URL('.', import.meta.url)),
  '../../../../packages/shared/openapi.json',
);

export interface XAuthz {
  actor: string;
  chain?: string[];
  rule?: string;
}

export interface ContractOperation {
  operationId: string;
  'x-authz'?: XAuthz;
  'x-fr'?: string[];
  parameters?: unknown[];
  requestBody?: unknown;
  responses?: Record<string, unknown>;
}

export interface OperationRef {
  operationId: string;
  method: string;
  path: string;
  operation: ContractOperation;
}

type Json = Record<string, unknown>;

interface ContractDocument extends Json {
  paths: Record<string, Record<string, ContractOperation>>;
}

const HTTP_METHODS = ['get', 'put', 'post', 'delete', 'patch'];

let cached: { doc: ContractDocument; operations: Map<string, OperationRef> } | undefined;

function load(): NonNullable<typeof cached> {
  if (cached) return cached;
  const doc = JSON.parse(readFileSync(CONTRACT_PATH, 'utf8')) as ContractDocument;
  const operations = new Map<string, OperationRef>();
  for (const [path, item] of Object.entries(doc.paths)) {
    for (const method of HTTP_METHODS) {
      const operation = item[method];
      if (operation)
        operations.set(operation.operationId, {
          operationId: operation.operationId,
          method,
          path,
          operation,
        });
    }
  }
  cached = { doc, operations };
  return cached;
}

export function contractDocument(): Json {
  return load().doc;
}

export function allOperations(): OperationRef[] {
  return [...load().operations.values()];
}

/** Finds an operation by `operationId`; throws for unknown ids so a typo in a test is loud. */
export function findOperation(operationId: string): OperationRef {
  const found = load().operations.get(operationId);
  if (!found)
    throw new Error(`Unknown operationId "${operationId}" (not in docs/api/openapi.yaml)`);
  return found;
}

/** Follows a local `$ref` such as `#/components/responses/NotFound` (one level at a time). */
function deref<T extends Json>(node: T | { $ref: string }): T {
  let current: Json = node as Json;
  while (typeof current.$ref === 'string') {
    const pointer = current.$ref
      .replace(/^#\//, '')
      .split('/')
      .map((p) => p.replaceAll('~1', '/').replaceAll('~0', '~'));
    let target: unknown = load().doc;
    for (const part of pointer) target = (target as Json)[part];
    current = target as Json;
  }
  return current as T;
}

let ajv: Ajv2020 | undefined;
const validators = new Map<string, ReturnType<Ajv2020['compile']>>();

function validatorFor(schemaPointer: string): ReturnType<Ajv2020['compile']> {
  const existing = validators.get(schemaPointer);
  if (existing) return existing;
  if (!ajv) {
    // OpenAPI 3.1 schemas are JSON Schema 2020-12. `strict: false` tolerates x-* extensions and
    // OpenAPI-only keywords such as `discriminator`.
    ajv = new Ajv2020({ strict: false, allErrors: true });
    addFormats.default(ajv);
    ajv.addSchema(load().doc, 'openapi', false);
  }
  const validate = ajv.compile({ $ref: `openapi#${schemaPointer}` });
  validators.set(schemaPointer, validate);
  return validate;
}

const escapePointer = (segment: string): string =>
  segment.replaceAll('~', '~0').replaceAll('/', '~1');

/** Minimal shape of a Fastify `inject` response (kept structural so the helper has no framework import). */
export interface ContractResponse {
  statusCode: number;
  headers: Record<string, unknown>;
  body: string;
  json(): unknown;
}

/**
 * Asserts that a response is declared by the contract for the operation: the status code is listed
 * (or `default`), the content type is one of the declared media types, and a JSON body validates
 * against the declared schema (docs/plan.md, "API-тесты по контракту").
 */
export function expectMatchesContract(operationId: string, response: ContractResponse): void {
  const { method, path, operation } = findOperation(operationId);
  const responses = operation.responses ?? {};
  const key = String(response.statusCode) in responses ? String(response.statusCode) : 'default';
  const declared = responses[key];
  expect(
    declared,
    `${operationId}: status ${response.statusCode} is not declared in the contract`,
  ).toBeDefined();

  const content = (deref(declared as Json).content ?? {}) as Record<string, { schema?: Json }>;
  if (Object.keys(content).length === 0) {
    expect(response.body, `${operationId}: ${response.statusCode} must have no body`).toBe('');
    return;
  }
  const contentType =
    String(response.headers['content-type'] ?? '')
      .split(';')[0]
      ?.trim() ?? '';
  expect(Object.keys(content), `${operationId}: undeclared media type "${contentType}"`).toContain(
    contentType,
  );

  const schema = content[contentType]?.schema;
  if (!schema) return;
  const base = `/paths/${escapePointer(path)}/${method}/responses/${key}`;
  const pointer =
    typeof (declared as Json).$ref === 'string'
      ? `${String((declared as Json).$ref).slice(1)}/content/${escapePointer(contentType)}/schema`
      : `${base}/content/${escapePointer(contentType)}/schema`;
  const validate = validatorFor(pointer);
  const ok = validate(response.json());
  const errors = (validate.errors ?? [])
    .map((e) => `${e.instancePath || '/'} ${e.message ?? ''}`)
    .join('; ');
  expect(ok, `${operationId} ${response.statusCode}: body violates the contract: ${errors}`).toBe(
    true,
  );
}
