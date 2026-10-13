import { Inject, Injectable } from '@nestjs/common';
import { uuidv7 } from 'uuidv7';
import type { Body } from 'shared';
import { Clock } from '../../../../platform/clock/clock.js';
import { DomainError } from '../../../../platform/errors/domain-error.js';
import { LockService } from '../../../../platform/tx/locks.js';
import { OutboxService } from '../../../../platform/outbox/outbox.service.js';
import { TxRunner } from '../../../../platform/tx/tx-runner.js';
import { assignOrdinals, diffSeat, expandSeats, seatLimitError } from '../domain/team-rules.js';
import { SeatRepository } from '../repositories/seat.repository.js';
import { TeamEventRepository } from '../repositories/team-event.repository.js';
import { TeamRepository } from '../repositories/team.repository.js';
import { SeatCatalogCheck } from './seat-catalog-check.js';
import type { SeatDto } from './team-dto.js';
import { journalRow, teamsEvent } from './team-events.js';
import { TeamLeadLock, VersionConflict } from './team-lead-lock.js';
import { TeamViewService } from './team-view.service.js';

type AddBody = Body<'addSeats'>;
type PatchBody = Body<'updateSeat'>;

interface RawSeat {
  id: string;
  team_id: string;
  role_code: string;
  status: string;
  desired: boolean;
  min_level: string;
  min_hours: number;
  stack: string[];
  version: number;
}

/** addSeats, updateSeat and closeSeat (FR-TEAM-02, FR-TEAM-03, FR-TEAM-12); lock order #4 team -> #5 seat. */
@Injectable()
export class SeatService {
  constructor(
    @Inject(TxRunner) private readonly tx: TxRunner,
    @Inject(Clock) private readonly clock: Clock,
    @Inject(LockService) private readonly locks: LockService,
    @Inject(OutboxService) private readonly outbox: OutboxService,
    @Inject(TeamRepository) private readonly teams: TeamRepository,
    @Inject(SeatRepository) private readonly seats: SeatRepository,
    @Inject(TeamEventRepository) private readonly events: TeamEventRepository,
    @Inject(TeamLeadLock) private readonly leadLock: TeamLeadLock,
    @Inject(SeatCatalogCheck) private readonly catalog: SeatCatalogCheck,
    @Inject(TeamViewService) private readonly view: TeamViewService,
  ) {}

  /** C-04 is checked against `team.seat_count` under the team lock, so parallel additions cannot exceed 12. */
  async add(userId: string, teamId: string, body: AddBody): Promise<{ items: SeatDto[] }> {
    const specs = expandSeats(body.seats);
    if (seatLimitError(0, specs.length) !== undefined) throw this.seatLimit(0, specs.length);
    await this.catalog.check(body.seats);
    const ids = await this.tx.run(() => this.addInTx(userId, teamId, specs));
    return { items: await this.view.seatsByIds(teamId, ids) };
  }

  private async addInTx(
    userId: string,
    teamId: string,
    specs: ReturnType<typeof expandSeats>,
  ): Promise<string[]> {
    const team = await this.leadLock.lock(teamId, userId);
    if (seatLimitError(team.seatCount, specs.length) !== undefined) {
      throw this.seatLimit(team.seatCount, specs.length);
    }
    const now = this.clock.now();
    const highest = await this.seats.highestOrdinals(teamId, [
      ...new Set(specs.map((s) => s.roleCode)),
    ]);
    const ordinals = assignOrdinals(specs, highest);
    const rows = specs.map((spec, index) => ({
      id: uuidv7(),
      teamId,
      ...spec,
      ordinal: ordinals[index] ?? 1,
      desiredChangedAt: spec.desired ? now : null,
      status: 'open',
      openedAt: now,
    }));
    await this.seats.insertMany(rows);
    await this.teams.adjustSeatCount(teamId, rows.length, now);
    await this.events.insertMany(
      rows.map((s) =>
        journalRow(
          teamId,
          'seat_opened',
          userId,
          { seatId: s.id, roleCode: s.roleCode, desired: s.desired },
          now,
        ),
      ),
    );
    await this.outbox.publishMany(
      rows.map((s) =>
        teamsEvent('seat_opened', s.id, {
          seatId: s.id,
          teamId,
          roleCode: s.roleCode,
          openedAt: now.toISOString(),
        }),
      ),
    );
    return rows.map((row) => row.id);
  }

  private seatLimit(existing: number, adding: number): DomainError {
    const error = seatLimitError(existing, adding);
    return new DomainError('SEAT_LIMIT', 422, error === undefined ? {} : { errors: [error] });
  }

  /** The desired mark is logged with its own journal row and `desired_changed_at` (FR-TEAM-03, AF-14). */
  async update(userId: string, teamId: string, seatId: string, body: PatchBody): Promise<SeatDto> {
    if (body.stack !== undefined) await this.catalog.checkStack(body.stack);
    try {
      await this.tx.run(() => this.updateInTx(userId, teamId, seatId, body));
    } catch (error) {
      if (!(error instanceof VersionConflict)) throw error;
      const current = await this.view.seat(teamId, seatId);
      throw new DomainError('VERSION_CONFLICT', 409, { current: { ...current } });
    }
    return this.view.seat(teamId, seatId);
  }

  private async updateInTx(
    userId: string,
    teamId: string,
    seatId: string,
    body: PatchBody,
  ): Promise<void> {
    await this.leadLock.lock(teamId, userId);
    const seat = await this.lockSeat(teamId, seatId);
    if (seat.version !== body.version) throw new VersionConflict();
    if (seat.status === 'closed') throw new DomainError('INVALID_STATE', 409);
    const change = diffSeat(
      {
        desired: seat.desired,
        minLevel: seat.min_level,
        minHours: seat.min_hours,
        stack: seat.stack,
      },
      body,
    );
    const now = this.clock.now();
    const journal = this.journalOf(teamId, userId, seat, change, now);
    if (journal.length === 0) return;
    await this.seats.update(seatId, {
      ...change.set,
      ...(change.desiredChanged ? { desiredChangedAt: now } : {}),
      version: seat.version + 1,
    });
    await this.events.insertMany(journal);
    if (change.desiredChanged) {
      await this.outbox.publishMany([
        teamsEvent('seat_desired_changed', seatId, {
          seatId,
          teamId,
          roleCode: seat.role_code,
          desired: change.set.desired,
        }),
      ]);
    }
  }

  /** One row for the desired mark (FR-TEAM-03) and one for changed requirements. */
  private journalOf(
    teamId: string,
    userId: string,
    seat: RawSeat,
    change: ReturnType<typeof diffSeat>,
    now: Date,
  ): ReturnType<typeof journalRow>[] {
    const rows: ReturnType<typeof journalRow>[] = [];
    if (change.desiredChanged) {
      const payload = {
        seatId: seat.id,
        roleCode: seat.role_code,
        from: seat.desired,
        to: change.set.desired,
      };
      rows.push(journalRow(teamId, 'seat_desired_changed', userId, payload, now));
    }
    if (change.requirementsChanged.length > 0) {
      const payload = { seatId: seat.id, fields: change.requirementsChanged };
      rows.push(journalRow(teamId, 'seat_updated', userId, payload, now));
    }
    return rows;
  }

  /**
   * Only an `open` seat can be closed (409 INVALID_STATE otherwise). The seat lock (#5) is the one
   * join takes, so closing and joining the same seat are serialized: the loser sees the new status.
   */
  async close(userId: string, teamId: string, seatId: string): Promise<void> {
    await this.tx.run(async () => {
      await this.leadLock.lock(teamId, userId);
      const seat = await this.lockSeat(teamId, seatId);
      if (seat.status !== 'open') throw new DomainError('INVALID_STATE', 409);
      const now = this.clock.now();
      await this.seats.update(seatId, { status: 'closed', version: seat.version + 1 });
      await this.teams.adjustSeatCount(teamId, -1, now);
      await this.events.insertMany([
        journalRow(teamId, 'seat_closed', userId, { seatId, roleCode: seat.role_code }, now),
      ]);
      await this.outbox.publishMany([
        teamsEvent('seat_closed', seatId, { seatId, teamId, roleCode: seat.role_code }),
      ]);
    });
  }

  /** Lock #5. A seat id of another team is "not found": the team id is part of the lookup chain. */
  private async lockSeat(teamId: string, seatId: string): Promise<RawSeat> {
    const [row] = await this.locks.lockSeats<RawSeat & Record<string, unknown>>([seatId]);
    if (row === undefined || row.team_id !== teamId) throw new DomainError('NOT_FOUND', 404);
    return row;
  }
}
