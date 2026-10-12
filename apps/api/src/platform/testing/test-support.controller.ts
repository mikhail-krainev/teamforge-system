import { Body, Controller, Get, Inject, Param, Post, Put, Req, UseGuards } from '@nestjs/common';
import type { FastifyRequest } from 'fastify';
import { sql } from 'drizzle-orm';
import { DomainError } from '../errors/domain-error.js';
import { Operation } from '../http/operation.decorator.js';
import { OutboxService } from '../outbox/outbox.service.js';
import { RateLimiter } from '../ratelimit/rate-limiter.js';
import { TxRunner } from '../tx/tx-runner.js';
import { TestUserGuard } from './test-user.guard.js';

interface EchoBody {
  value: string;
  /** Pause inside the transaction so that concurrent requests overlap. */
  delayMs?: number;
  /** Simulates a domain rejection (4xx, stored) or an unexpected failure (5xx, released). */
  fail?: 'domain' | 'internal';
}

interface VersionedBody {
  version: number;
  value: string;
}

const pause = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

@Controller('v1/_test')
@UseGuards(TestUserGuard)
export class TestSupportController {
  constructor(
    @Inject(TxRunner) private readonly tx: TxRunner,
    @Inject(OutboxService) private readonly outbox: OutboxService,
    @Inject(RateLimiter) private readonly limiter: RateLimiter,
  ) {}

  /** One effect row (and one outbox event) per executed request. */
  @Post('echo')
  @Operation('testEcho')
  async echo(@Body() body: EchoBody): Promise<{ value: string; effects: number }> {
    return this.tx.run(async () => {
      const { value, delayMs, fail } = body;
      await this.tx.tx.execute(sql`INSERT INTO public.tf_test_effect (value) VALUES (${value})`);
      if (delayMs) await pause(delayMs);
      if (fail === 'domain') throw new DomainError('INVALID_STATE', 409, { detail: 'rejected' });
      if (fail === 'internal') throw new Error('boom');
      await this.outbox.publish({
        module: 'platform',
        type: 'test_echo',
        aggregateId: '00000000-0000-4000-8000-000000000001',
        payload: { value },
      });
      const rows = await this.tx.tx.execute(
        sql`SELECT count(*)::int AS n FROM public.tf_test_effect`,
      );
      return { value, effects: Number((rows[0] as { n: number }).n) };
    });
  }

  /** Optimistic write (CC-7 pattern): conditional UPDATE by version. */
  @Put('versioned/:id')
  @Operation('testVersioned')
  async versioned(
    @Param('id') id: string,
    @Body() body: VersionedBody,
  ): Promise<{ id: string; version: number; value: string }> {
    return this.tx.run(async () => {
      const rows = await this.tx.tx.execute(
        sql`UPDATE public.tf_test_versioned SET value = ${body.value}, version = version + 1
            WHERE id = ${id}::uuid AND version = ${body.version}
            RETURNING id, version, value`,
      );
      const row = rows[0] as { id: string; version: number; value: string } | undefined;
      if (row) return row;
      const current = await this.tx.tx.execute(
        sql`SELECT id, version, value FROM public.tf_test_versioned WHERE id = ${id}::uuid`,
      );
      if (current.length === 0) throw new DomainError('NOT_FOUND', 404);
      throw new DomainError('VERSION_CONFLICT', 409, {
        current: current[0] as Record<string, unknown>,
      });
    });
  }

  /** Rate-limited probe: 3 requests per minute per client IP. */
  @Get('limited')
  @Operation('testLimited')
  async limited(@Req() request: FastifyRequest): Promise<{ remaining: number }> {
    const subject = this.limiter.ipSubject(request.ip);
    const result = await this.limiter.enforce('apiRead', subject, { limit: 3, windowMs: 60_000 });
    return { remaining: result.remaining };
  }

  /** Reports the client IP the API derived (trustProxy tests). */
  @Get('ip')
  @Operation('testIp')
  ip(@Req() request: FastifyRequest): { ip: string } {
    return { ip: request.ip };
  }
}
