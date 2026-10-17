import { Body, Controller, Get, HttpCode, Inject, Param, Post, Query, Res } from '@nestjs/common';
import type { FastifyReply } from 'fastify';
import { ClsService } from 'nestjs-cls';
import type { Ok } from 'shared';
import { requireUserId } from '../../../../platform/context/cls-store.js';
import { DomainError } from '../../../../platform/errors/domain-error.js';
import { API_PREFIX } from '../../../../platform/http/fastify.js';
import { Authz } from '../../../../platform/http/operation.decorator.js';
import { PlaybookAdminService } from '../loader/playbook-admin.service.js';
import { type PlaybookListQuery, PlaybookReadService } from '../read/playbook-read.service.js';

/**
 * The body of uploadPlaybook is the file itself: `application/yaml` arrives as a string, `application/json`
 * as an already parsed object, which is stored as JSON text (JSON is YAML).
 */
function sourceText(body: unknown): string {
  if (typeof body === 'string') return body;
  if (typeof body === 'object' && body !== null) return JSON.stringify(body);
  throw new DomainError('VALIDATION_FAILED', 400, {
    errors: [{ pointer: '/', code: 'required', message: 'request body is required' }],
  });
}

/** listPlaybooks, getPlaybook, getTemplate, adminListPlaybooks, uploadPlaybook, publishPlaybook (FR-PLAY-01..05, -07). */
@Controller('v1')
export class PlaybookController {
  constructor(
    @Inject(PlaybookReadService) private readonly read: PlaybookReadService,
    @Inject(PlaybookAdminService) private readonly admin: PlaybookAdminService,
    @Inject(ClsService) private readonly cls: ClsService,
  ) {}

  @Get('playbooks')
  @Authz('listPlaybooks')
  listPlaybooks(@Query() query: PlaybookListQuery): Promise<Ok<'listPlaybooks'>> {
    return this.read.list(query, false);
  }

  @Get('playbooks/:playbookId')
  @Authz('getPlaybook')
  getPlaybook(@Param('playbookId') playbookId: string): Promise<Ok<'getPlaybook'>> {
    return this.read.get(playbookId, requireUserId(this.cls));
  }

  @Get('templates/:key')
  @Authz('getTemplate')
  getTemplate(@Param('key') key: string): Promise<Ok<'getTemplate'>> {
    return this.read.getTemplate(key);
  }

  @Get('admin/playbooks')
  @Authz('adminListPlaybooks')
  adminListPlaybooks(@Query() query: PlaybookListQuery): Promise<Ok<'adminListPlaybooks'>> {
    return this.read.list(query, true);
  }

  @Post('admin/playbooks')
  @Authz('uploadPlaybook')
  async uploadPlaybook(
    @Body() body: unknown,
    @Res({ passthrough: true }) reply: FastifyReply,
  ): Promise<Ok<'uploadPlaybook'>> {
    const result = await this.admin.upload(requireUserId(this.cls), sourceText(body));
    void reply.header('Location', `/${API_PREFIX}/v1/playbooks/${result.playbook.id}`);
    return result;
  }

  @Post('admin/playbooks/:playbookId/publication')
  @HttpCode(200)
  @Authz('publishPlaybook')
  publishPlaybook(@Param('playbookId') playbookId: string): Promise<Ok<'publishPlaybook'>> {
    return this.admin.publish(playbookId);
  }
}
