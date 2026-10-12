import {
  Inject,
  Injectable,
  Optional,
  type OnApplicationBootstrap,
  RequestMethod,
} from '@nestjs/common';
import { METHOD_METADATA, PATH_METADATA } from '@nestjs/common/constants.js';
import { DiscoveryService, MetadataScanner } from '@nestjs/core';
import { ActorPolicies } from './actor-policies.js';
import {
  type ContractDocument,
  type OperationSpec,
  readContractOperations,
} from './contract-operations.js';
import { OperationValidators } from './operation-validators.js';
import { OPERATION_KEY } from '../http/operation.decorator.js';

/** The contract document (`packages/shared/openapi.json`); tests replace it with a synthetic one. */
export const CONTRACT_DOCUMENT = Symbol('CONTRACT_DOCUMENT');
/** Operations that exist only in the runtime (test-support probes); they carry their own `x-authz`. */
export const EXTRA_OPERATIONS = Symbol('EXTRA_OPERATIONS');

/** A route handler found in a controller. */
export interface DiscoveredRoute {
  method: string;
  /** Nest style path (`/v1/teams/:teamId`) without the global prefix. */
  path: string;
  /** `Controller.method`, for messages. */
  handler: string;
  operationId: string | undefined;
}

const METHOD_NAMES: Record<number, string> = {
  [RequestMethod.GET]: 'get',
  [RequestMethod.POST]: 'post',
  [RequestMethod.PUT]: 'put',
  [RequestMethod.DELETE]: 'delete',
  [RequestMethod.PATCH]: 'patch',
};

/** `/v1/teams/:teamId/` -> `/v1/teams/{teamId}`: the notation of the contract. */
export function toContractPath(...segments: string[]): string {
  const joined = `/${segments.join('/')}`.replaceAll(/\/+/g, '/').replace(/(.)\/$/, '$1');
  return joined.replaceAll(/:([A-Za-z0-9_]+)/g, '{$1}');
}

function asArray(value: unknown): string[] {
  if (Array.isArray(value)) return value.map(String);
  return [typeof value === 'string' ? value : ''];
}

/**
 * Runtime point of application of SEC-03 (architecture 13.14): knows every operation (contract +
 * runtime-only extras), checks at startup that each route handler is bound to an operation that has
 * an `x-authz` whose `actor` has a policy, and hands the guards what they need per request.
 * A violation aborts the application start, so a controller can never be reachable "open".
 */
@Injectable()
export class AuthzRegistry implements OnApplicationBootstrap {
  private readonly operations = new Map<string, OperationSpec>();
  private validators: OperationValidators | undefined;

  constructor(
    @Inject(CONTRACT_DOCUMENT) private readonly doc: ContractDocument,
    @Inject(DiscoveryService) private readonly discovery: DiscoveryService,
    @Inject(MetadataScanner) private readonly scanner: MetadataScanner,
    @Inject(ActorPolicies) private readonly policies: ActorPolicies,
    @Optional() @Inject(EXTRA_OPERATIONS) private readonly extras: OperationSpec[] = [],
  ) {
    for (const [id, spec] of readContractOperations(doc)) this.operations.set(id, spec);
    for (const extra of extras) this.operations.set(extra.operationId, extra);
  }

  onApplicationBootstrap(): void {
    const problems = this.verify(this.discoverRoutes());
    if (problems.length > 0) {
      throw new Error(
        `Authorization registry check failed, the application does not start:\n  - ${problems.join('\n  - ')}`,
      );
    }
    const used = new Set(
      this.discoverRoutes().flatMap((r) => (r.operationId ? [r.operationId] : [])),
    );
    this.validators = new OperationValidators(
      this.doc,
      [...used].flatMap((id) => this.operations.get(id) ?? []),
    );
  }

  get(operationId: string): OperationSpec | undefined {
    return this.operations.get(operationId);
  }

  /** Compiled request schemas; available once the application started. */
  get requestValidators(): OperationValidators | undefined {
    return this.validators;
  }

  /** Every controller route handler, with the operation it declares (if any). */
  discoverRoutes(): DiscoveredRoute[] {
    const routes: DiscoveredRoute[] = [];
    for (const wrapper of this.discovery.getControllers()) {
      const { instance, metatype } = wrapper;
      if (!instance || !metatype) continue;
      const prototype = Object.getPrototypeOf(instance) as object;
      for (const name of this.scanner.getAllMethodNames(prototype)) {
        const handler = (prototype as Record<string, unknown>)[name] as object;
        const route = this.routeOf(metatype, handler, `${metatype.name}.${name}`);
        if (route) routes.push(route);
      }
    }
    return routes;
  }

  private routeOf(controller: object, handler: object, label: string): DiscoveredRoute | undefined {
    const method = Reflect.getMetadata(METHOD_METADATA, handler) as number | undefined;
    if (method === undefined) return undefined;
    const base = asArray(Reflect.getMetadata(PATH_METADATA, controller))[0] ?? '';
    const own = asArray(Reflect.getMetadata(PATH_METADATA, handler))[0] ?? '';
    return {
      method: METHOD_NAMES[method] ?? String(method),
      path: toContractPath(base, own),
      handler: label,
      operationId: Reflect.getMetadata(OPERATION_KEY, handler) as string | undefined,
    };
  }

  /** Pure check of discovered routes against the known operations; returns the violations. */
  verify(routes: readonly DiscoveredRoute[]): string[] {
    const problems: string[] = [];
    const seen = new Map<string, string>();
    for (const route of routes) {
      const where = `${route.method.toUpperCase()} ${route.path} (${route.handler})`;
      if (route.operationId === undefined) {
        problems.push(`${where}: no @Authz(operationId); every route must name its operation`);
        continue;
      }
      const duplicate = seen.get(route.operationId);
      if (duplicate !== undefined) {
        problems.push(`${where}: operation ${route.operationId} is already used by ${duplicate}`);
      }
      seen.set(route.operationId, where);
      problems.push(...this.verifyOperation(route, where));
    }
    return problems;
  }

  private verifyOperation(route: DiscoveredRoute, where: string): string[] {
    const spec = this.operations.get(route.operationId ?? '');
    if (spec === undefined) {
      return [`${where}: operation ${route.operationId} is not in the contract`];
    }
    if (spec.authz === undefined) {
      return [`${where}: operation ${spec.operationId} has no x-authz in the contract`];
    }
    const problems: string[] = [];
    if (spec.method !== route.method || spec.path !== route.path) {
      problems.push(
        `${where}: the contract declares ${spec.operationId} as ${spec.method.toUpperCase()} ${spec.path}`,
      );
    }
    if (this.policies.get(spec.authz.actor) === undefined) {
      problems.push(
        `${where}: actor "${spec.authz.actor}" of ${spec.operationId} has no registered policy`,
      );
    }
    return problems;
  }
}
