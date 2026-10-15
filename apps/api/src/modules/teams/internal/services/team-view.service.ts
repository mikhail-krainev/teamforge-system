import { Inject, Injectable } from '@nestjs/common';
import { DomainError } from '../../../../platform/errors/domain-error.js';
import { PLAYBOOKS_API, type PlaybooksApi } from '../../../playbooks/public.js';
import { PROFILES_API, type ProfilesApi } from '../../../profiles/public.js';
import { SeatRepository } from '../repositories/seat.repository.js';
import { TeamRepository } from '../repositories/team.repository.js';
import { type MemberDto, type SeatDto, type TeamDto, toSeatDto, toTeamDto } from './team-dto.js';

/**
 * Builds the `Team` and `Seat` resources. Reads only; runs after the business transaction has
 * committed (or before it starts), never while a row lock is held, because it calls other modules.
 */
@Injectable()
export class TeamViewService {
  constructor(
    @Inject(TeamRepository) private readonly teams: TeamRepository,
    @Inject(SeatRepository) private readonly seats: SeatRepository,
    @Inject(PROFILES_API) private readonly profiles: ProfilesApi,
    @Inject(PLAYBOOKS_API) private readonly playbooks: PlaybooksApi,
  ) {}

  /**
   * The public card of a team. Private fields of members are not exposed: the trial end is shown
   * only to members of the same team.
   */
  async team(teamId: string, viewerId: string): Promise<TeamDto> {
    const row = await this.teams.find(teamId);
    if (row === undefined) throw new DomainError('NOT_FOUND', 404);
    const [seatRows, memberRows, assignments, versions] = await Promise.all([
      this.seats.listByTeam(teamId),
      this.teams.activeMembers(teamId),
      this.teams.activeAssignments(teamId),
      this.playbooks.getVersions([row.playbookId]),
    ]);
    const names = await this.profiles.getDisplayNames(memberRows.map((m) => m.userId));
    const viewerIsMember = memberRows.some((m) => m.userId === viewerId);
    const members: MemberDto[] = memberRows.map((m) => ({
      userId: m.userId,
      displayName: names.get(m.userId) ?? '',
      status: m.status as MemberDto['status'],
      joinedVia: m.joinedVia as MemberDto['joinedVia'],
      joinedAt: m.joinedAt.toISOString(),
      trialUntil: viewerIsMember ? (m.trialUntil?.toISOString() ?? null) : null,
      roles: assignments.filter((a) => a.membershipId === m.id).map((a) => a.roleCode),
      isLead: m.userId === row.leadUserId,
    }));
    return toTeamDto(row, {
      playbookVersion: versions.get(row.playbookId) ?? '',
      seats: seatRows.map(toSeatDto),
      members,
    });
  }

  /** The seats with the given ids, in the order of (role, ordinal). */
  async seatsByIds(teamId: string, seatIds: string[]): Promise<SeatDto[]> {
    const rows = await this.seats.listByTeam(teamId, seatIds);
    return rows.map(toSeatDto);
  }

  async seat(teamId: string, seatId: string): Promise<SeatDto> {
    const [found] = await this.seatsByIds(teamId, [seatId]);
    if (found === undefined) throw new DomainError('NOT_FOUND', 404);
    return found;
  }
}
