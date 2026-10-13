import { Inject, Injectable } from '@nestjs/common';
import { DomainError } from '../../../../platform/errors/domain-error.js';
import { LockService } from '../../../../platform/tx/locks.js';
import { statusBlock } from '../domain/team-rules.js';

/** The locked team row, as far as the lead operations need it. */
export interface LockedTeam {
  id: string;
  status: string;
  leadUserId: string | null;
  seatCount: number;
  version: number;
}

interface RawTeam {
  id: string;
  status: string;
  lead_user_id: string | null;
  seat_count: number;
  version: number;
}

/** Thrown inside a transaction when the caller's `version` is stale; the service turns it into 409. */
export class VersionConflict extends Error {
  constructor() {
    super('version conflict');
    this.name = 'VersionConflict';
  }
}

/**
 * Lock #4 for operations of the team lead. The policy `team-lead` read the lead before the
 * transaction; the lead can change meanwhile (vote, leaving), so it is checked again here, under
 * the lock, together with the status of the team.
 */
@Injectable()
export class TeamLeadLock {
  constructor(@Inject(LockService) private readonly locks: LockService) {}

  async lock(teamId: string, userId: string): Promise<LockedTeam> {
    const raw = await this.locks.lockTeam<RawTeam & Record<string, unknown>>(teamId);
    if (raw === undefined) throw new DomainError('NOT_FOUND', 404);
    if (raw.lead_user_id !== userId) throw new DomainError('NOT_TEAM_LEAD', 403);
    const blocked = statusBlock(raw.status);
    if (blocked !== undefined) throw new DomainError(blocked, 409);
    return {
      id: raw.id,
      status: raw.status,
      leadUserId: raw.lead_user_id,
      seatCount: raw.seat_count,
      version: raw.version,
    };
  }
}
