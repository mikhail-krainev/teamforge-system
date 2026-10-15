import { Inject, Injectable } from '@nestjs/common';
import { Clock } from '../../../../platform/clock/clock.js';
import { TxRunner } from '../../../../platform/tx/tx-runner.js';
import { PROFILES_API, type MatchingProfile, type ProfilesApi } from '../../../profiles/public.js';
import { TEAMS_API, type OpenSeatView, type TeamsApi } from '../../../teams/public.js';
import { evaluatePair, isPairAllowed, levelInRole } from '../domain/score.js';
import { CandidateStatsRepository } from '../repositories/candidate-stats.repository.js';
import {
  RecommendRepository,
  type MatchCandidateInsert,
  type QueueEntry,
} from '../repositories/recommend.repository.js';

/** Profiles per page of `listMatchingProfilesByRole` (the platform maximum). */
const PROFILE_PAGE = 100;
/** Open seats per page of `listOpenSeats`. */
const SEAT_PAGE = 500;
const NO_TEAMS: ReadonlySet<string> = new Set();

/**
 * Precomputation of `match_candidate` (architecture 6.3, FR-MATCH-01, FR-MATCH-02): every run reads
 * the state at its start, scores the pairs with the pure functions of `domain/score.ts` and writes
 * them in one transaction (upsert, then deletion of the pairs that no longer pass), so a reader sees
 * the old or the new score of a pair, never an empty list. Safe to run twice and in parallel.
 */
@Injectable()
export class ScoreRecomputeService {
  constructor(
    @Inject(Clock) private readonly clock: Clock,
    @Inject(TxRunner) private readonly tx: TxRunner,
    @Inject(TEAMS_API) private readonly teams: TeamsApi,
    @Inject(PROFILES_API) private readonly profiles: ProfilesApi,
    @Inject(RecommendRepository) private readonly matches: RecommendRepository,
    @Inject(CandidateStatsRepository) private readonly stats: CandidateStatsRepository,
  ) {}

  /** All candidates of one seat. Returns the number of pairs stored. */
  async recomputeSeat(seatId: string): Promise<number> {
    const startedAt = this.clock.now();
    const [seat] = await this.teams.listOpenSeats({ seatIds: [seatId], limit: 1 });
    if (seat === undefined) {
      await this.matches.deleteBySeat(seatId);
      return 0;
    }
    const rows = await this.rowsForSeat(seat, startedAt);
    await this.tx.run(async () => {
      await this.matches.upsert(rows);
      await this.matches.deleteStaleForSeat(
        seatId,
        rows.map((row) => row.userId),
        startedAt,
      );
    });
    return rows.length;
  }

  /** Every open seat of a team; seats that are not open any more lose their rows. */
  async recomputeTeam(teamId: string): Promise<number> {
    const startedAt = this.clock.now();
    const seats = await this.teams.listOpenSeats({ teamId, limit: SEAT_PAGE });
    const perSeat = await Promise.all(seats.map((seat) => this.rowsForSeat(seat, startedAt)));
    await this.tx.run(async () => {
      for (const [index, seat] of seats.entries()) {
        const rows = perSeat[index] ?? [];
        await this.matches.upsert(rows);
        await this.matches.deleteStaleForSeat(
          seat.seatId,
          rows.map((row) => row.userId),
          startedAt,
        );
      }
      await this.matches.deleteClosedSeatsOfTeam(
        teamId,
        seats.map((seat) => seat.seatId),
      );
    });
    return perSeat.reduce((sum, rows) => sum + rows.length, 0);
  }

  /** All open seats that suit one person (FR-MATCH-02), with the current `in_queue` flag. */
  async recomputeUser(userId: string): Promise<number> {
    const startedAt = this.clock.now();
    const [profile] = await this.profiles.getMatchingProfiles([userId]);
    if (profile === undefined) {
      await this.matches.deleteByUser(userId);
      return 0;
    }
    const entry = (await this.matches.queueEntries([userId])).get(userId);
    const completed = await this.stats.completedByRole(userId);
    const roleCodes = [
      ...new Set([...profile.rolePrefs.map((pref) => pref.roleCode), ...(entry?.roles ?? [])]),
    ];
    const rows: MatchCandidateInsert[] = [];
    let after: string | undefined;
    while (roleCodes.length > 0) {
      const seats = await this.teams.listOpenSeats({
        roleCodes,
        limit: SEAT_PAGE,
        ...(after === undefined ? {} : { afterSeatId: after }),
      });
      for (const seat of seats) {
        const row = this.pair(seat, profile, completed.get(seat.roleCode) ?? 0, entry, startedAt);
        if (row !== null) rows.push(row);
      }
      if (seats.length < SEAT_PAGE) break;
      after = seats.at(-1)?.seatId;
    }
    await this.tx.run(async () => {
      await this.matches.upsert(rows);
      await this.matches.deleteStaleForUser(
        userId,
        rows.map((row) => row.seatId),
        startedAt,
      );
    });
    return rows.length;
  }

  private async rowsForSeat(seat: OpenSeatView, at: Date): Promise<MatchCandidateInsert[]> {
    const rows: MatchCandidateInsert[] = [];
    let cursor: string | undefined;
    do {
      const page = await this.profiles.listMatchingProfilesByRole(seat.roleCode, {
        limit: PROFILE_PAGE,
        cursor,
      });
      const userIds = page.items.map((profile) => profile.userId);
      const [queue, completed] = await Promise.all([
        this.matches.queueEntries(userIds),
        this.stats.completedInRole(userIds, seat.roleCode),
      ]);
      for (const profile of page.items) {
        const row = this.pair(
          seat,
          profile,
          completed.get(profile.userId) ?? 0,
          queue.get(profile.userId),
          at,
        );
        if (row !== null) rows.push(row);
      }
      cursor = page.nextCursor ?? undefined;
    } while (cursor !== undefined);
    return rows;
  }

  /** One pair through the hard filters and the score; null when it does not pass. */
  private pair(
    seat: OpenSeatView,
    profile: MatchingProfile,
    completedInRole: number,
    entry: QueueEntry | undefined,
    at: Date,
  ): MatchCandidateInsert | null {
    if (!isPairAllowed(seat, profile.userId, entry?.excludedTeamIds ?? NO_TEAMS)) return null;
    const evaluation = evaluatePair(
      seat,
      {
        userId: profile.userId,
        level: levelInRole(profile.rolePrefs, seat.roleCode),
        hoursPerWeek: profile.hoursPerWeek,
        timezone: profile.timezone,
        stack: profile.stack,
        completedInRole,
      },
      at,
    );
    if (!evaluation.eligible) return null;
    return {
      seatId: seat.seatId,
      userId: profile.userId,
      teamId: seat.teamId,
      roleCode: seat.roleCode,
      score: evaluation.score.toFixed(3),
      reasons: evaluation.reasons,
      inQueue: entry?.roles.has(seat.roleCode) ?? false,
      computedAt: at,
    };
  }
}
