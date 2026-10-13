import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';

/** `x-authz` of an operation (architecture 13.14). */
export interface XAuthz {
  actor: string;
  chain?: string[];
  rule?: string;
}

export type JsonSchema = Record<string, unknown>;

/** Request schemas of an operation, already rewritten so that `$ref`s point into the `openapi` document. */
export interface OperationSchemas {
  params?: JsonSchema;
  query?: JsonSchema;
  body?: JsonSchema;
  bodyRequired?: boolean;
}

/** What the runtime knows about an operation: where it lives, who may call it, what it accepts. */
export interface OperationSpec {
  operationId: string;
  /** Lower-case HTTP method. */
  method: string;
  /** Contract style path without the `/api` prefix, e.g. `/v1/teams/{teamId}`. */
  path: string;
  /** Absent when the contract operation has no `x-authz`: AuthzRegistry rejects it at startup. */
  authz?: XAuthz;
  schemas: OperationSchemas;
  /** True when the contract takes `multipart/form-data` (the only routes that may read such a body). */
  multipart?: boolean;
}

type Json = Record<string, unknown>;

export interface ContractDocument extends Json {
  paths: Record<string, Record<string, Json>>;
}

/** Id under which the whole contract is registered in Ajv; every rewritten `$ref` starts with it. */
export const CONTRACT_SCHEMA_ID = 'openapi';

const HTTP_METHODS = ['get', 'put', 'post', 'delete', 'patch'] as const;

/** Reads the bundled contract that `pnpm --filter shared run generate` writes. */
export function loadContractDocument(): ContractDocument {
  const require = createRequire(import.meta.url);
  return JSON.parse(
    readFileSync(require.resolve('shared/openapi.json'), 'utf8'),
  ) as ContractDocument;
}

function decodePointerSegment(segment: string): string {
  return segment.replaceAll('~1', '/').replaceAll('~0', '~');
}

function resolveRef(doc: ContractDocument, ref: string): unknown {
  let node: unknown = doc;
  for (const part of ref.replace(/^#\//, '').split('/')) {
    node = (node as Json | undefined)?.[decodePointerSegment(part)];
  }
  return node;
}

function deref<T extends Json>(doc: ContractDocument, node: T): T {
  let current: Json = node;
  for (let hops = 0; typeof current.$ref === 'string' && hops < 10; hops += 1) {
    current = (resolveRef(doc, current.$ref) as Json | undefined) ?? {};
  }
  return current as T;
}

/** Points every local `$ref` of a schema into the document registered as `openapi`. */
export function rewriteRefs<T>(node: T): T {
  if (Array.isArray(node)) return node.map((item) => rewriteRefs(item)) as T;
  if (node === null || typeof node !== 'object') return node;
  const out: Json = {};
  for (const [key, value] of Object.entries(node as Json)) {
    out[key] =
      key === '$ref' && typeof value === 'string' && value.startsWith('#')
        ? `${CONTRACT_SCHEMA_ID}${value}`
        : rewriteRefs(value);
  }
  return out as T;
}

function objectSchema(
  properties: Record<string, unknown>,
  required: string[],
): JsonSchema | undefined {
  if (Object.keys(properties).length === 0) return undefined;
  return { type: 'object', properties, required };
}

function parameterSchemas(doc: ContractDocument, operation: Json): Partial<OperationSchemas> {
  const groups: Record<'path' | 'query', { props: Record<string, unknown>; required: string[] }> = {
    path: { props: {}, required: [] },
    query: { props: {}, required: [] },
  };
  for (const raw of (operation.parameters as Json[] | undefined) ?? []) {
    const param = deref(doc, raw);
    const location = param.in;
    if ((location !== 'path' && location !== 'query') || typeof param.name !== 'string') continue;
    const group = groups[location];
    group.props[param.name] = rewriteRefs(param.schema ?? {});
    if (param.required === true || location === 'path') group.required.push(param.name);
  }
  return {
    params: objectSchema(groups.path.props, groups.path.required),
    query: objectSchema(groups.query.props, groups.query.required),
  };
}

function bodySchema(doc: ContractDocument, operation: Json): Partial<OperationSchemas> {
  const body =
    operation.requestBody === undefined ? undefined : deref(doc, operation.requestBody as Json);
  const content = (body?.content ?? {}) as Record<string, { schema?: unknown }>;
  const schema = content['application/json']?.schema;
  if (schema === undefined) return {};
  return { body: rewriteRefs(schema as JsonSchema), bodyRequired: body?.required === true };
}

function acceptsMultipart(doc: ContractDocument, operation: Json): boolean {
  const body =
    operation.requestBody === undefined ? undefined : deref(doc, operation.requestBody as Json);
  return 'multipart/form-data' in ((body?.content ?? {}) as Record<string, unknown>);
}

/** Every operation of the contract keyed by `operationId`. */
export function readContractOperations(doc: ContractDocument): Map<string, OperationSpec> {
  const operations = new Map<string, OperationSpec>();
  for (const [path, item] of Object.entries(doc.paths)) {
    for (const method of HTTP_METHODS) {
      const operation = item[method];
      if (operation === undefined || typeof operation.operationId !== 'string') continue;
      operations.set(operation.operationId, {
        operationId: operation.operationId,
        method,
        path,
        authz: operation['x-authz'] as XAuthz | undefined,
        schemas: { ...parameterSchemas(doc, operation), ...bodySchema(doc, operation) },
        ...(acceptsMultipart(doc, operation) ? { multipart: true } : {}),
      });
    }
  }
  return operations;
}
