import { Controller, Get, Inject, Res } from '@nestjs/common';
import type { FastifyReply } from 'fastify';
import { Operation } from '../http/operation.decorator.js';
import { type HealthReport, HealthService } from './health.service.js';

@Controller('health')
export class HealthController {
  constructor(@Inject(HealthService) private readonly health: HealthService) {}

  @Get('live')
  @Operation('healthLive')
  live(): HealthReport {
    return this.health.live();
  }

  @Get('ready')
  @Operation('healthReady')
  async ready(@Res({ passthrough: true }) reply: FastifyReply): Promise<HealthReport> {
    const report = await this.health.ready();
    if (report.status === 'down') void reply.status(503).header('Retry-After', '1');
    return report;
  }
}
