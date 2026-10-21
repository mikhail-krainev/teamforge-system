import { Inject, Injectable } from '@nestjs/common';
import { DomainError } from '../../../../platform/errors/domain-error.js';
import { LockService } from '../../../../platform/tx/locks.js';
import { TEAMS_API, type TeamLockView, type TeamsApi } from '../../../teams/public.js';
import { ItemRepository } from '../repositories/item.repository.js';
import type { ItemRow, StageRow } from '../repositories/route.repository.js';
import type { ChecklistItemDto } from './route-dto.js';
import { RouteQueryService } from './route-query.service.js';

/** Thrown inside a transaction when the caller's `version` is stale; the service turns it into 409. */
export class VersionConflict extends Error {
  constructor() {
    super('version conflict');
    this.name = 'VersionConflict';
  }
}

export interface OpenedItem {
  team: TeamLockView;
  item: ItemRow;
  stage: StageRow;
}

export interface GateOptions {
  /** The caller must be the lead of the team (checked again under the lock). */
  lead?: string;
  /** The caller must be an active member. */
  member?: string;
  /** Lock #4 mode; `update` for a write that also changes the team (the release link, T7). Default `share`. */
  teamLock?: 'update' | 'share';
}

/** FR-WORK-18: a suspended project is read-only; a vote also stops the lead's operations. */
export function assertTeamWritable(status: string, leadOperation: boolean): void {
  if (status === 'completed' || status === 'archived') throw new DomainError('INVALID_STATE', 409);
  if (status === 'suspended' || (leadOperation && status === 'voting')) {
    throw new DomainError('TEAM_STATUS_BLOCKS_ACTION', 409);
  }
}

/**
 * The common start of the three item writes (architecture 12): lock #4 `team FOR SHARE`, the item
 * of this team, lock #8 `project_stage FOR SHARE`; level 9 (the item itself) is a conditional
 * UPDATE. The status of the team decides what is allowed (FR-WORK-18).
 */
@Injectable()
export class ItemGate {
  constructor(
    @Inject(TEAMS_API) private readonly teams: TeamsApi,
    @Inject(LockService) private readonly locks: LockService,
    @Inject(ItemRepository) private readonly items: ItemRepository,
    @Inject(RouteQueryService) private readonly query: RouteQueryService,
  ) {}

  async open(teamId: string, itemId: string, who: GateOptions): Promise<OpenedItem> {
    const team = await this.teams.lockTeam(teamId, who.teamLock ?? 'share');
    if (who.lead !== undefined && team.leadUserId !== who.lead) {
      throw new DomainError('NOT_TEAM_LEAD', 403);
    }
    if (who.member !== undefined) await this.teams.assertMember(teamId, who.member);
    assertTeamWritable(team.status, who.lead !== undefined);
    const found = await this.items.findItem(teamId, itemId);
    if (found === undefined) throw new DomainError('NOT_FOUND', 404);
    await this.locks.lockProjectStage(found.projectStageId, 'share');
    const stage = await this.items.findStage(teamId, found.projectStageId);
    if (stage === undefined) throw new DomainError('NOT_FOUND', 404);
    if (stage.status !== 'open') throw new DomainError('STAGE_NOT_OPEN', 409);
    // Read again under the stage lock: this is the row the version is compared with.
    const item = await this.items.findItem(teamId, itemId);
    if (item === undefined) throw new DomainError('NOT_FOUND', 404);
    return { team, item, stage };
  }

  /** The 409 for a stale version, carrying the stored item (the client reapplies its change). */
  async conflict(teamId: string, itemId: string): Promise<DomainError> {
    const current: ChecklistItemDto = await this.query.getItem(teamId, itemId);
    return new DomainError('VERSION_CONFLICT', 409, { current: { ...current } });
  }
}
