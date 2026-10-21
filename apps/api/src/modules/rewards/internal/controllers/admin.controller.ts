import { Body, Controller, Get, HttpCode, Inject, Param, Post, Query } from '@nestjs/common';
import { ClsService } from 'nestjs-cls';
import type { Body as BodyOf, Ok } from 'shared';
import { requireUserId } from '../../../../platform/context/cls-store.js';
import { Authz } from '../../../../platform/http/operation.decorator.js';
import { FraudCaseService, type CaseQuery } from '../admin/fraud-case.service.js';

/** The queue of manual review: the list, a case and the decision (FR-REW-12, FR-REW-16, FR-AUTH-08). */
@Controller('v1/admin/fraud-cases')
export class AdminController {
  constructor(
    @Inject(FraudCaseService) private readonly cases: FraudCaseService,
    @Inject(ClsService) private readonly cls: ClsService,
  ) {}

  @Get()
  @Authz('listFraudCases')
  listFraudCases(@Query() query: CaseQuery): Promise<Ok<'listFraudCases'>> {
    return this.cases.list(query);
  }

  @Get(':caseId')
  @Authz('getFraudCase')
  getFraudCase(@Param('caseId') caseId: string): Promise<Ok<'getFraudCase'>> {
    return this.cases.get(caseId);
  }

  @Post(':caseId/decision')
  @HttpCode(200)
  @Authz('decideFraudCase')
  decideFraudCase(
    @Param('caseId') caseId: string,
    @Body() body: BodyOf<'decideFraudCase'>,
  ): Promise<Ok<'decideFraudCase'>> {
    return this.cases.decide(requireUserId(this.cls), caseId, body.decision, body.comment);
  }
}
