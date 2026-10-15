import { Inject, Injectable } from '@nestjs/common';
import { ModuleRef } from '@nestjs/core';
import { TEAMS_API, type DeficitPort, type TeamsApi } from '../../../teams/public.js';
import { isDeficit } from './demand-rules.js';
import { DemandRepository } from './demand.repository.js';

/**
 * `DeficitPort` implementation (FR-MATCH-11, FR-TEAM-25), called by teams inside the join
 * transaction before the seat changes. Both numbers are counted fresh, without the cache: the
 * seat being taken is still `open`, so it is part of `openSeats`. A person who joins by invitation,
 * offer or request and is himself queued for the role is not counted in the queue; an auto-added
 * person still is (his application is active until the pair is settled).
 *
 * Joins to different seats of one role in parallel each see the other's seat as open (risk 17.7,
 * accepted): each stored record is consistent with some order of the joins.
 */
@Injectable()
export class MatchingDeficitPort implements DeficitPort {
  private teamsApi: TeamsApi | undefined;

  constructor(
    @Inject(ModuleRef) private readonly modules: ModuleRef,
    @Inject(DemandRepository) private readonly demand: DemandRepository,
  ) {}

  /**
   * Resolved on first use: `TeamsApi` -> join service -> `DEFICIT_PORT` -> `TeamsApi` is a cycle
   * of providers (teams calls this port, this port reads teams), so it cannot be injected.
   */
  private get teams(): TeamsApi {
    this.teamsApi ??= this.modules.get<TeamsApi>(TEAMS_API, { strict: false });
    return this.teamsApi;
  }

  async evaluate(
    input: Parameters<DeficitPort['evaluate']>[0],
  ): ReturnType<DeficitPort['evaluate']> {
    const [counts, queued] = await Promise.all([
      this.teams.countOpenSeatsByRole([input.roleCode]),
      this.demand.queuedForRole(
        input.roleCode,
        input.via === 'auto' ? undefined : input.joiningUserId,
      ),
    ]);
    const openSeats = Math.max(counts[0]?.openSeats ?? 0, input.openSeats);
    return { deficit: isDeficit(openSeats, queued), openSeats, queued };
  }
}
