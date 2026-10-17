import { Inject, Injectable } from '@nestjs/common';
import { Clock } from '../../../../platform/clock/clock.js';
import { PROFILES_API, type ProfilesApi } from '../../../profiles/public.js';
import { TEAMS_API, type TeamsApi } from '../../../teams/public.js';
import type { RoleDemand } from '../../public.js';
import { DemandCache } from './demand-cache.js';
import { buildRoleDemand, uniqueRoles, WAIT_WINDOW_DAYS } from './demand-rules.js';
import { DemandRepository } from './demand.repository.js';

const DAY_MS = 86_400_000;

/** The demand showcase (FR-MATCH-09, FR-MATCH-11, FR-PROF-07). */
@Injectable()
export class DemandService {
  constructor(
    @Inject(Clock) private readonly clock: Clock,
    @Inject(DemandCache) private readonly cache: DemandCache,
    @Inject(DemandRepository) private readonly demand: DemandRepository,
    @Inject(TEAMS_API) private readonly teams: TeamsApi,
    @Inject(PROFILES_API) private readonly profiles: ProfilesApi,
  ) {}

  /** The roles asked for; without any, the desired roles of the caller's profile. */
  async rolesOrDesired(userId: string, asked: readonly string[]): Promise<string[]> {
    if (asked.length > 0) return uniqueRoles(asked);
    const [profile] = await this.profiles.getMatchingProfiles([userId]);
    return uniqueRoles((profile?.rolePrefs ?? []).map((p) => p.roleCode));
  }

  /** One row per requested role in the order asked; misses are counted together and cached. */
  async getDemand(roles: readonly string[]): Promise<RoleDemand[]> {
    const wanted = await this.knownRoles(uniqueRoles(roles));
    const cached = await this.cache.read(wanted);
    const missing = wanted.filter((r) => !cached.has(r));
    const fresh = await this.compute(missing);
    await this.cache.write(fresh);
    const byRole = new Map([...cached, ...fresh.map((row) => [row.roleCode, row] as const)]);
    return wanted.flatMap((r) => byRole.get(r) ?? []);
  }

  /** Requested roles that exist in the active catalog: nothing else becomes a cache key. */
  private async knownRoles(roles: string[]): Promise<string[]> {
    if (roles.length === 0) return roles;
    const active = new Set((await this.profiles.listRoles()).map((role) => role.code));
    return roles.filter((role) => active.has(role));
  }

  private async compute(roles: string[]): Promise<RoleDemand[]> {
    if (roles.length === 0) return [];
    const now = this.clock.now();
    const since = new Date(now.getTime() - WAIT_WINDOW_DAYS * DAY_MS);
    const [seats, queued, waits] = await Promise.all([
      this.teams.countOpenSeatsByRole(roles),
      this.demand.queuedByRole(roles),
      this.demand.waitStatsByRole(roles, since),
    ]);
    const seatsByRole = new Map(seats.map((s) => [s.roleCode, s]));
    return roles.map((role) =>
      buildRoleDemand(
        role,
        {
          openSeats: seatsByRole.get(role)?.openSeats ?? 0,
          teamsSeeking: seatsByRole.get(role)?.teamsSeeking ?? 0,
          queued: queued.get(role) ?? 0,
          wait: waits.get(role),
        },
        now,
      ),
    );
  }
}
