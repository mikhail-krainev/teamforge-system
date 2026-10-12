import { Body, Controller, Get, Inject, Param, Post, Put, Req } from '@nestjs/common';
import type { FastifyRequest } from 'fastify';
import { sql } from 'drizzle-orm';
import { DomainError } from '../../src/platform/errors/domain-error.js';
import { Authz } from '../../src/platform/http/operation.decorator.js';
import { OutboxService } from '../../src/platform/outbox/outbox.service.js';
import { RateLimiter } from '../../src/platform/ratelimit/rate-limiter.js';
import { TxRunner } from '../../src/platform/tx/tx-runner.js';

interface EchoBody {
  value: string;
  /** Pause inside the transaction so that concurrent requests overlap. */
  delayMs?: number;
  /** Simulates a domain rejection (4xx, stored), a temporary refusal (429/503, released) or a crash. */
  fail?: 'domain' | 'internal' | 'rate_limited' | 'unavailable';
  /** Application deadline of one transaction attempt (tests of the attempt timeout). */
  attemptTimeoutMs?: number;
}

interface VersionedBody {
  version: number;
  value: string;
}

interface AccountBody {
  email: string;
  token: string;
}

const pause = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

@Controller('v1/_test')
export class TestSupportController {
  constructor(
    @Inject(TxRunner) private readonly tx: TxRunner,
    @Inject(OutboxService) private readonly outbox: OutboxService,
    @Inject(RateLimiter) private readonly limiter: RateLimiter,
  ) {}

  /** One effect row (and one outbox event) per executed request. */
  @Post('echo')
  @Authz('testEcho')
  async echo(@Body() body: EchoBody): Promise<{ value: string; effects: number }> {
    const options = body.attemptTimeoutMs ? { attemptTimeoutMs: body.attemptTimeoutMs } : {};
    return this.tx.run(async () => {
      const { value, delayMs, fail } = body;
      await this.tx.tx.execute(sql`INSERT INTO public.tf_test_effect (value) VALUES (${value})`);
      if (delayMs) await pause(delayMs);
      this.failIfRequested(fail);
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
    }, options);
  }

  private failIfRequested(fail: EchoBody['fail']): void {
    if (fail === 'domain') throw new DomainError('INVALID_STATE', 409, { detail: 'rejected' });
    if (fail === 'internal') throw new Error('boom');
    if (fail === 'rate_limited') {
      throw new DomainError('RATE_LIMITED', 429, {
        retryAfterSeconds: 1,
        headers: { 'Retry-After': '1' },
      });
    }
    if (fail === 'unavailable') throw new DomainError('LOCK_TIMEOUT', 503);
  }

  /**
   * Violates the one-transaction-per-operation rule on purpose: two top-level transactions in one
   * request. Under an idempotency key the second one must be refused (S1R-02).
   */
  @Post('two-transactions')
  @Authz('testTwoTransactions')
  async twoTransactions(@Body() body: { value: string }): Promise<{ done: boolean }> {
    await this.tx.run(async () => {
      await this.tx.tx.execute(
        sql`INSERT INTO public.tf_test_effect (value) VALUES (${`${body.value}-1`})`,
      );
    });
    await this.tx.run(async () => {
      await this.tx.tx.execute(
        sql`INSERT INTO public.tf_test_effect (value) VALUES (${`${body.value}-2`})`,
      );
    });
    return { done: true };
  }

  /** Converts the transaction result into another DTO: the key must store THIS response. */
  @Post('dto')
  @Authz('testDto')
  async dto(@Body() body: { value: string }): Promise<{ id: string; shaped: true }> {
    const row = await this.tx.run(async () => {
      await this.tx.tx.execute(
        sql`INSERT INTO public.tf_test_effect (value) VALUES (${body.value})`,
      );
      return { internalColumn: 'must-not-leak', value: body.value };
    });
    return { id: row.value, shaped: true };
  }

  /** Writes a row with an email and a token and fails on the second call (23505, parameters bound). */
  @Post('accounts')
  @Authz('testAccounts')
  async accounts(@Body() body: AccountBody): Promise<{ ok: true }> {
    await this.tx.run(async () => {
      await this.tx.tx.execute(
        sql`INSERT INTO public.tf_test_account (email, token) VALUES (${body.email}, ${body.token})`,
      );
    });
    return { ok: true };
  }

  /** Optimistic write (CC-7 pattern): conditional UPDATE by version. */
  @Put('versioned/:id')
  @Authz('testVersioned')
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

  /** A mutating operation that is rate limited INSIDE the handler: one write per second per user. */
  @Post('limited-write')
  @Authz('testLimitedWrite')
  async limitedWrite(
    @Req() request: FastifyRequest,
    @Body() body: { value: string },
  ): Promise<{ value: string }> {
    const user = String(request.headers['x-test-user']);
    await this.limiter.enforce('apiWrite', this.limiter.userSubject(user), {
      limit: 1,
      windowMs: 1000,
    });
    return { value: body.value };
  }

  /** Rate-limited probe: 3 requests per minute per client IP. */
  @Get('limited')
  @Authz('testLimited')
  async limited(@Req() request: FastifyRequest): Promise<{ remaining: number }> {
    const subject = this.limiter.ipSubject(request.ip);
    const result = await this.limiter.enforce('apiRead', subject, { limit: 3, windowMs: 60_000 });
    return { remaining: result.remaining };
  }

  /** Reports the client IP the API derived (trustProxy tests). */
  @Get('ip')
  @Authz('testIp')
  ip(@Req() request: FastifyRequest): { ip: string } {
    return { ip: request.ip };
  }
}
