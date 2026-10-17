import { Inject, Injectable } from '@nestjs/common';
import type { Ok } from 'shared';
import {
  buildPage,
  clampLimit,
  decodeCursor,
  type Page,
} from '../../../../platform/db/pagination.js';
import { DomainError } from '../../../../platform/errors/domain-error.js';
import { toSummary, type PlaybookSummaryDto } from '../loader/playbook-loader.js';
import { AdminProbe } from './admin-probe.js';
import { PlaybookReader, type PlaybookFull } from './playbook-reader.js';

export interface PlaybookListQuery {
  cursor?: string | undefined;
  limit?: number | undefined;
  productType?: string | undefined;
}

type PlaybookDto = Ok<'getPlaybook'>;
type TemplateDto = Ok<'getTemplate'>;

function toDto(full: PlaybookFull): PlaybookDto {
  return {
    ...toSummary(full.row),
    stages: full.stages.map((stage) => ({
      key: stage.key,
      ordinal: stage.ordinal,
      title: stage.title,
      goal: stage.goal,
      durationDays: stage.durationDays,
      exitCriteria: stage.exitCriteria,
      steps: stage.steps.map((step) => ({
        key: step.key,
        title: step.title,
        description: step.description,
        type: step.kind,
        submission: step.submission,
        ritualKind: step.ritualKind,
        required: step.required,
        ownerRole: step.ownerRole,
        altRoles: step.altRoles,
        fallback: step.fallback,
        reviewChecklist: step.reviewChecklist,
        reviewItems: step.reviewItems,
        autoChecks: step.autoChecks,
        sources: step.sources,
      })),
    })),
  };
}

/** Read side of the playbooks module: listPlaybooks, adminListPlaybooks, getPlaybook, getTemplate. */
@Injectable()
export class PlaybookReadService {
  constructor(
    @Inject(PlaybookReader) private readonly reader: PlaybookReader,
    @Inject(AdminProbe) private readonly admin: AdminProbe,
  ) {}

  /** FR-PLAY-03 (published only) and FR-PLAY-05 (`includeDrafts`, the admin listing). */
  async list(query: PlaybookListQuery, includeDrafts: boolean): Promise<Page<PlaybookSummaryDto>> {
    const filters = { productType: query.productType ?? null, drafts: includeDrafts };
    const limit = clampLimit(query.limit);
    let after;
    if (query.cursor !== undefined) {
      const [productType, major, minor, patch] = decodeCursor(query.cursor, filters).k;
      if (
        typeof productType !== 'string' ||
        typeof major !== 'number' ||
        typeof minor !== 'number' ||
        typeof patch !== 'number'
      ) {
        throw new DomainError('VALIDATION_FAILED', 400, {
          errors: [{ pointer: '/cursor', code: 'invalid_cursor', message: 'Invalid cursor' }],
        });
      }
      after = { productType, major, minor, patch };
    }
    const rows = await this.reader.list({
      productType: query.productType,
      includeDrafts,
      after,
      limit,
    });
    return buildPage(
      rows.map(toSummary),
      limit,
      (item) => {
        const [major = 0, minor = 0, patch = 0] = item.version.split('.').map(Number);
        return [item.productTypeCode, major, minor, patch];
      },
      filters,
    );
  }

  /** FR-PLAY-01: a draft is visible to an administrator only, everybody else gets 404. */
  async get(id: string, viewerId: string): Promise<PlaybookDto> {
    const row = await this.reader.findRow(id);
    if (row === undefined) throw new DomainError('NOT_FOUND', 404);
    if (row.status !== 'published' && !(await this.admin.isAdmin(viewerId))) {
      throw new DomainError('NOT_FOUND', 404);
    }
    return toDto(await this.reader.loadTree(row));
  }

  async getTemplate(key: string): Promise<TemplateDto> {
    const row = await this.reader.latestTemplate(key);
    if (row === undefined) throw new DomainError('NOT_FOUND', 404);
    return { key: row.key, version: row.version, title: row.title, bodyMd: row.bodyMd };
  }
}
