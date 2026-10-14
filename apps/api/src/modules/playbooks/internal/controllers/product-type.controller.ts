import { Controller, Get, Inject } from '@nestjs/common';
import type { Ok } from 'shared';
import { Authz } from '../../../../platform/http/operation.decorator.js';
import { PLAYBOOKS_API, type PlaybooksApi } from '../../public.js';

/** Product types for the team creation form (FR-PLAY-06); public, read-only. */
@Controller('v1/product-types')
export class ProductTypeController {
  constructor(@Inject(PLAYBOOKS_API) private readonly playbooks: PlaybooksApi) {}

  @Get()
  @Authz('listProductTypes')
  async listProductTypes(): Promise<Ok<'listProductTypes'>> {
    return { items: await this.playbooks.listProductTypes() };
  }
}
