import {
  Body,
  Controller,
  Get,
  Global,
  Inject,
  Injectable,
  Module,
  Param,
  Post,
  Query,
} from '@nestjs/common';
import { APP_FILTER } from '@nestjs/core';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { Test } from '@nestjs/testing';
import { ClsModule } from 'nestjs-cls';
import { PinoLogger } from 'nestjs-pino';
import { afterEach, describe, expect, it } from 'vitest';
import {
  ActorPolicies,
  SESSION_AUTHENTICATOR,
  type SessionAuthenticator,
} from '../src/platform/authz/actor-policies.js';
import { AuthzGuard } from '../src/platform/authz/authz.guard.js';
import { AuthzModule } from '../src/platform/authz/authz.module.js';
import { CONTRACT_DOCUMENT } from '../src/platform/authz/authz.registry.js';
import type { ContractDocument } from '../src/platform/authz/contract-operations.js';
import { DomainError } from '../src/platform/errors/domain-error.js';
import { ProblemFilter } from '../src/platform/errors/problem.filter.js';
import { Authz } from '../src/platform/http/operation.decorator.js';

const uuid = { type: 'string', format: 'uuid' };

/** A small synthetic contract: what matters is how the runtime treats it, not its content. */
const doc: ContractDocument = {
  openapi: '3.1.0',
  paths: {
    '/health/live': { get: { operationId: 'healthLive', 'x-authz': { actor: 'public' } } },
    '/v1/me': { get: { operationId: 'getMe', 'x-authz': { actor: 'authenticated' } } },
    '/v1/orphan': { get: { operationId: 'noAuthzOperation' } },
    '/v1/teams/{teamId}': {
      get: {
        operationId: 'getTeam',
        'x-authz': { actor: 'team-member', chain: ['teamId'] },
        parameters: [{ name: 'teamId', in: 'path', required: true, schema: uuid }],
      },
    },
    '/v1/things/{thingId}': {
      post: {
        operationId: 'createThing',
        'x-authz': { actor: 'public' },
        parameters: [
          { name: 'thingId', in: 'path', required: true, schema: uuid },
          { name: 'limit', in: 'query', schema: { type: 'integer', minimum: 1, maximum: 100 } },
        ],
        requestBody: {
          required: true,
          content: { 'application/json': { schema: { $ref: '#/components/schemas/Thing' } } },
        },
      },
    },
  },
  components: {
    schemas: {
      Thing: {
        type: 'object',
        required: ['name'],
        additionalProperties: false,
        properties: {
          name: { type: 'string', maxLength: 5 },
          tags: { type: 'array', items: { type: 'string' } },
        },
      },
    },
  },
};

@Controller('health')
class HealthStub {
  @Get('live')
  @Authz('healthLive')
  live(): { status: string } {
    return { status: 'up' };
  }
}

@Controller('v1')
class MeStub {
  @Get('me')
  @Authz('getMe')
  me(): { ok: true } {
    return { ok: true };
  }
}

@Controller('v1/teams')
class TeamStub {
  @Get(':teamId')
  @Authz('getTeam')
  team(@Param('teamId') teamId: string): { teamId: string } {
    return { teamId };
  }
}

@Controller('v1/things')
class ThingStub {
  @Post(':thingId')
  @Authz('createThing')
  create(
    @Param() params: Record<string, unknown>,
    @Query() query: Record<string, unknown>,
    @Body() body: Record<string, unknown>,
  ): unknown {
    return { params, query, body };
  }
}

@Controller('v1')
class NoDecoratorStub {
  @Get('bare')
  bare(): string {
    return 'open';
  }
}

@Controller('v1')
class UnknownOperationStub {
  @Get('x')
  @Authz('doesNotExist')
  x(): string {
    return 'x';
  }
}

@Controller('v1')
class OrphanStub {
  @Get('orphan')
  @Authz('noAuthzOperation')
  orphan(): string {
    return 'x';
  }
}

@Controller('v1')
class WrongPathStub {
  @Get('elsewhere')
  @Authz('getMe')
  me(): string {
    return 'x';
  }
}

/** Registers the policy of a (future) actor, the way a domain module will in slices 2-7. */
@Injectable()
class TeamMemberPolicy {
  constructor(@Inject(ActorPolicies) policies: ActorPolicies) {
    policies.register('team-member', {
      requiresSession: true,
      check: ({ request, authz, userId }) => {
        const chain = authz.chain ?? [];
        const first = (request.params as Record<string, string>)[chain[0] ?? ''];
        if (userId !== 'member' || first === 'foreign') throw new DomainError('NOT_FOUND', 404);
      },
    });
  }
}

@Global()
@Module({})
class SessionStubModule {
  static with(authenticator: SessionAuthenticator) {
    return {
      module: SessionStubModule,
      providers: [{ provide: SESSION_AUTHENTICATOR, useValue: authenticator }],
      exports: [SESSION_AUTHENTICATOR],
    };
  }
}

const headerSession: SessionAuthenticator = {
  authenticate: (request) => {
    const header = request.headers['x-user'];
    return typeof header === 'string' ? header : undefined;
  },
};

interface StartOptions {
  controllers: (new () => object)[];
  session?: boolean;
  policy?: boolean;
}

describe('S1-13 AuthzRegistry, deny-by-default guard and ValidationGuard', () => {
  let app: NestFastifyApplication | undefined;

  afterEach(async () => {
    await app?.close();
    app = undefined;
  });

  async function start(options: StartOptions): Promise<NestFastifyApplication> {
    const moduleRef = await Test.createTestingModule({
      imports: [
        ClsModule.forRoot({ global: true, middleware: { mount: true } }),
        AuthzModule,
        ...(options.session ? [SessionStubModule.with(headerSession)] : []),
      ],
      controllers: options.controllers,
      providers: [
        { provide: PinoLogger, useValue: { error: () => undefined } },
        { provide: APP_FILTER, useClass: ProblemFilter },
        ...(options.policy ? [TeamMemberPolicy] : []),
      ],
    })
      .overrideProvider(CONTRACT_DOCUMENT)
      .useValue(doc)
      .compile();
    app = moduleRef.createNestApplication<NestFastifyApplication>(new FastifyAdapter());
    await app.init();
    await app.getHttpAdapter().getInstance().ready();
    return app;
  }

  describe('the application does not start when a route is not bound to an authorised operation', () => {
    it('route without @Authz(operationId)', async () => {
      await expect(start({ controllers: [HealthStub, NoDecoratorStub] })).rejects.toThrow(
        /GET \/v1\/bare \(NoDecoratorStub\.bare\): no @Authz\(operationId\)/,
      );
    });

    it('operation that is not in the contract', async () => {
      await expect(start({ controllers: [UnknownOperationStub] })).rejects.toThrow(
        /operation doesNotExist is not in the contract/,
      );
    });

    it('contract operation without x-authz', async () => {
      await expect(start({ controllers: [OrphanStub] })).rejects.toThrow(
        /operation noAuthzOperation has no x-authz/,
      );
    });

    it('actor without a registered policy', async () => {
      await expect(start({ controllers: [TeamStub] })).rejects.toThrow(
        /actor "team-member" of getTeam has no registered policy/,
      );
    });

    it('handler whose method or path differs from the contract', async () => {
      await expect(start({ controllers: [WrongPathStub] })).rejects.toThrow(
        /the contract declares getMe as GET \/v1\/me/,
      );
    });

    it('a correct set of routes starts', async () => {
      const running = await start({ controllers: [HealthStub, MeStub], session: true });
      const response = await running.inject({ method: 'GET', url: '/health/live' });
      expect(response.statusCode).toBe(200);
    });
  });

  describe('runtime guard: deny by default, then the policy of the actor', () => {
    it('public operations need no session', async () => {
      const running = await start({ controllers: [HealthStub] });
      expect((await running.inject({ method: 'GET', url: '/health/live' })).statusCode).toBe(200);
    });

    it('an authenticated operation answers 401 without a session provider', async () => {
      const running = await start({ controllers: [MeStub] });
      const response = await running.inject({
        method: 'GET',
        url: '/v1/me',
        headers: { 'x-user': 'u1' },
      });
      expect(response.statusCode).toBe(401);
      expect(response.json()).toMatchObject({ code: 'UNAUTHENTICATED' });
    });

    it('an authenticated operation answers 401 without a session and 200 with one', async () => {
      const running = await start({ controllers: [MeStub], session: true });
      expect((await running.inject({ method: 'GET', url: '/v1/me' })).statusCode).toBe(401);
      const ok = await running.inject({
        method: 'GET',
        url: '/v1/me',
        headers: { 'x-user': 'u1' },
      });
      expect(ok.statusCode).toBe(200);
    });

    it('passes the chain of x-authz to the actor policy (extension point of slices 2-7)', async () => {
      const running = await start({ controllers: [TeamStub], session: true, policy: true });
      const own = '11111111-1111-4111-8111-111111111111';
      const get = (id: string, user?: string) =>
        running.inject({
          method: 'GET',
          url: `/v1/teams/${id}`,
          headers: user ? { 'x-user': user } : {},
        });
      expect((await get(own, 'member')).statusCode).toBe(200);
      expect((await get(own)).statusCode).toBe(401);
      expect((await get(own, 'stranger')).statusCode).toBe(404);
    });

    it('refuses a handler with no operation (403) even if the startup check was bypassed', async () => {
      const registry = { get: () => undefined };
      const reflector = { get: () => undefined };
      const guard = new AuthzGuard(reflector as never, registry as never, new ActorPolicies(), {
        set: () => undefined,
      } as never);
      const context = {
        getType: () => 'http',
        getHandler: () => function bare() {},
        switchToHttp: () => ({ getRequest: () => ({}) }),
      };
      const error = await guard.canActivate(context as never).catch((e: unknown) => e);
      expect(error).toMatchObject({ code: 'FORBIDDEN', status: 403 });
    });
  });

  describe('ValidationGuard (architecture 13.3)', () => {
    const id = '22222222-2222-4222-8222-222222222222';
    const post = (url: string, payload?: unknown) =>
      app?.inject({
        method: 'POST',
        url,
        ...(payload === undefined ? {} : { payload: payload as Record<string, unknown> }),
      });

    it('coerces query and path values, drops unknown fields and passes the cleaned data on', async () => {
      await start({ controllers: [ThingStub] });
      const response = await post(`/v1/things/${id}?limit=10&unknown=1`, {
        name: 'abc',
        tags: ['a'],
        extra: 'dropped',
      });
      expect(response?.statusCode).toBe(201);
      expect(response?.json()).toEqual({
        params: { thingId: id },
        query: { limit: 10 },
        body: { name: 'abc', tags: ['a'] },
      });
    });

    it('answers 400 VALIDATION_FAILED problem+json with JSON Pointers and no submitted values', async () => {
      await start({ controllers: [ThingStub] });
      const secret = 'SECRET-VALUE';
      const response = await post(`/v1/things/not-a-uuid?limit=500`, { name: secret, tags: [1] });
      expect(response?.statusCode).toBe(400);
      expect(response?.headers['content-type']).toContain('application/problem+json');
      const body = response?.json<{ code: string; errors: { pointer: string; code: string }[] }>();
      expect(body?.code).toBe('VALIDATION_FAILED');
      const pointers = body?.errors.map((e) => e.pointer) ?? [];
      expect(pointers).toEqual(
        expect.arrayContaining(['/params/thingId', '/query/limit', '/name', '/tags/0']),
      );
      expect(JSON.stringify(body)).not.toContain(secret);
    });

    it('points at the missing property and rejects a missing body', async () => {
      await start({ controllers: [ThingStub] });
      const missing = await post(`/v1/things/${id}`, { tags: [] });
      expect(
        missing?.json<{ errors: { pointer: string; code: string }[] }>().errors,
      ).toContainEqual(expect.objectContaining({ pointer: '/name', code: 'required' }));
      const empty = await post(`/v1/things/${id}`);
      expect(empty?.statusCode).toBe(400);
      expect(empty?.json<{ errors: { pointer: string }[] }>().errors[0]?.pointer).toBe('/');
    });
  });
});
