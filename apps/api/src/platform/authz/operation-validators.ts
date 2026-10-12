import { Ajv2020, type ErrorObject, type ValidateFunction } from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
import type { FieldError } from '../errors/domain-error.js';
import {
  CONTRACT_SCHEMA_ID,
  type ContractDocument,
  type JsonSchema,
  type OperationSpec,
} from './contract-operations.js';

export interface RequestParts {
  params: unknown;
  query: unknown;
  body: unknown;
}

interface Compiled {
  params?: ValidateFunction;
  query?: ValidateFunction;
  body?: ValidateFunction;
  bodyRequired: boolean;
}

function createAjv(doc: ContractDocument, coerce: boolean): Ajv2020 {
  // Contract schemas are OpenAPI 3.1 (JSON Schema 2020-12); `strict: false` tolerates the `x-*`
  // extensions and OpenAPI-only keywords such as `discriminator`.
  const ajv = new Ajv2020({
    strict: false,
    allErrors: true,
    // Unknown fields are dropped (spec 5.3), so `request_hash` is computed over the cleaned body.
    removeAdditional: 'all',
    coerceTypes: coerce ? 'array' : false,
  });
  addFormats.default(ajv);
  ajv.addSchema(doc, CONTRACT_SCHEMA_ID);
  return ajv;
}

/** JSON Pointer of the offending value; `required` points at the missing property. */
function pointerOf(error: ErrorObject, prefix: string): string {
  const missing = error.keyword === 'required' ? String(error.params.missingProperty) : undefined;
  const base = `${prefix}${error.instancePath}`;
  return missing === undefined ? base || '/' : `${base}/${missing}`;
}

/** Messages come from Ajv keywords only: they never contain the submitted values. */
function toFieldErrors(errors: ErrorObject[] | null | undefined, prefix: string): FieldError[] {
  return (errors ?? []).map((error) => ({
    pointer: pointerOf(error, prefix),
    code: error.keyword,
    message: error.message ?? 'invalid',
  }));
}

/**
 * Request schemas of the operations compiled once at startup (architecture 13.3, ADR-0007):
 * path and query parameters with type coercion, the JSON body without it. Body errors carry
 * body-relative pointers (`/roles/1/priority`), the others `/params/<name>` and `/query/<name>`.
 */
export class OperationValidators {
  private readonly compiled = new Map<string, Compiled>();

  constructor(doc: ContractDocument, specs: Iterable<OperationSpec>) {
    const strict = createAjv(doc, false);
    const coercing = createAjv(doc, true);
    for (const spec of specs) {
      const { params, query, body, bodyRequired } = spec.schemas;
      this.compiled.set(spec.operationId, {
        params: this.compile(coercing, params),
        query: this.compile(coercing, query),
        body: this.compile(strict, body),
        bodyRequired: bodyRequired === true,
      });
    }
  }

  private compile(ajv: Ajv2020, schema: JsonSchema | undefined): ValidateFunction | undefined {
    return schema === undefined ? undefined : ajv.compile(schema);
  }

  has(operationId: string): boolean {
    return this.compiled.has(operationId);
  }

  /** Validates (and cleans, coerces) the request parts in place; returns the violations. */
  validate(operationId: string, parts: RequestParts): FieldError[] {
    const compiled = this.compiled.get(operationId);
    if (compiled === undefined) return [];
    const errors: FieldError[] = [];
    if (compiled.params && !compiled.params(parts.params ?? {})) {
      errors.push(...toFieldErrors(compiled.params.errors, '/params'));
    }
    if (compiled.query && !compiled.query(parts.query ?? {})) {
      errors.push(...toFieldErrors(compiled.query.errors, '/query'));
    }
    if (compiled.body) errors.push(...this.validateBody(compiled, parts.body));
    return errors;
  }

  private validateBody(compiled: Compiled, body: unknown): FieldError[] {
    if (compiled.body === undefined) return [];
    if (body === undefined || body === null) {
      return compiled.bodyRequired
        ? [{ pointer: '/', code: 'required', message: 'request body is required' }]
        : [];
    }
    return compiled.body(body) ? [] : toFieldErrors(compiled.body.errors, '');
  }
}
