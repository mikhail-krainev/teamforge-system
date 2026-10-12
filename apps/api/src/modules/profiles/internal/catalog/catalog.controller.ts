import { Body, Controller, Get, Inject, Param, Patch, Post, Query } from '@nestjs/common';
import type { Page } from '../../../../platform/db/pagination.js';
import { Authz } from '../../../../platform/http/operation.decorator.js';
import type { CatalogEntry } from './catalog.repository.js';
import { CatalogService, type StackTagListInput } from './catalog.service.js';

interface EntryBody {
  code: string;
  name: string;
}

interface PatchBody {
  name?: string;
  active?: boolean;
}

/** Contract operations of FR-PROF-09; bodies and queries are validated by ValidationGuard. */
@Controller('v1')
export class CatalogController {
  constructor(@Inject(CatalogService) private readonly catalog: CatalogService) {}

  @Get('catalog/roles')
  @Authz('listRoles')
  listRoles(@Query() query: { includeInactive?: boolean }): Promise<{ items: CatalogEntry[] }> {
    return this.catalog.listRoles(query.includeInactive);
  }

  @Get('catalog/stack-tags')
  @Authz('listStackTags')
  listStackTags(@Query() query: StackTagListInput): Promise<Page<CatalogEntry>> {
    return this.catalog.listStackTags(query);
  }

  @Post('admin/catalog/roles')
  @Authz('createRole')
  createRole(@Body() body: EntryBody): Promise<CatalogEntry> {
    return this.catalog.create('role', body);
  }

  @Patch('admin/catalog/roles/:code')
  @Authz('updateRole')
  updateRole(@Param('code') code: string, @Body() body: PatchBody): Promise<CatalogEntry> {
    return this.catalog.update('role', code, body);
  }

  @Post('admin/catalog/stack-tags')
  @Authz('createStackTag')
  createStackTag(@Body() body: EntryBody): Promise<CatalogEntry> {
    return this.catalog.create('stackTag', body);
  }

  @Patch('admin/catalog/stack-tags/:code')
  @Authz('updateStackTag')
  updateStackTag(@Param('code') code: string, @Body() body: PatchBody): Promise<CatalogEntry> {
    return this.catalog.update('stackTag', code, body);
  }
}
