import { Inject, Injectable } from '@nestjs/common';
import type { Body } from 'shared';
import { Clock } from '../../../../platform/clock/clock.js';
import {
  type CursorPayload,
  type Page,
  buildPage,
  clampLimit,
  decodeCursor,
} from '../../../../platform/db/pagination.js';
import { DomainError } from '../../../../platform/errors/domain-error.js';
import { OutboxService } from '../../../../platform/outbox/outbox.service.js';
import { LockService } from '../../../../platform/tx/locks.js';
import { TxRunner } from '../../../../platform/tx/tx-runner.js';
import { decisionPointerError, departureOverdue } from '../domain/departure-rules.js';
import {
  type DepartureCursor,
  type DepartureRow,
  DepartureRepository,
} from '../repositories/departure.repository.js';
import { SeatRepository } from '../repositories/seat.repository.js';
import { TeamEventRepository } from '../repositories/team-event.repository.js';
import { TeamRepository } from '../repositories/team.repository.js';
import { type DepartureDto, toDepartureDto } from './departure-dto.js';
import { journalRow, teamsEvent } from './team-events.js';
import { TeamLeadLock } from './team-lead-lock.js';

export interface DeparturesQuery {
  cursor?: string | undefined;
  limit?: number | undefined;
}

interface RawDeparture {
  id: string;
  team_id: string;
  decision: string;
  due_at: Date | string;
  seat_ids: string[];
}

interface RawSeat {
  id: string;
  team_id: string;
  role_code: string;
  status: string;
  version: number;
}

function keysetOf(payload: CursorPayload): DepartureCursor {
  const [at, id] = payload.k;
  const when = typeof at === 'string' ? new Date(at) : undefined;
  if (when === undefined || Number.isNaN(when.getTime()) || typeof id !== 'string') {
    throw new DomainError('VALIDATION_FAILED', 400, {
      errors: [{ pointer: '/cursor', code: 'invalid_cursor', message: 'Invalid cursor' }],
    });
  }
  return { dueAt: when, id };
}

/**
 * listDepartures, decideDeparture and the `departure-default` timer (FR-TEAM-12, -13, C-14).
 * The lead and the timer meet at the same row: lock #3 `departure FOR UPDATE`, then only a
 * `pending` departure is decided, so exactly one of them wins (architecture 12.3).
 */
@Injectable()
export class DepartureService {
  constructor(
    @Inject(TxRunner) private readonly tx: TxRunner,
    @Inject(Clock) private readonly clock: Clock,
    @Inject(LockService) private readonly locks: LockService,
    @Inject(OutboxService) private readonly outbox: OutboxService,
    @Inject(DepartureRepository) private readonly departures: DepartureRepository,
    @Inject(SeatRepository) private readonly seats: SeatRepository,
    @Inject(TeamRepository) private readonly teams: TeamRepository,
    @Inject(TeamEventRepository) private readonly events: TeamEventRepository,
    @Inject(TeamLeadLock) private readonly leadLock: TeamLeadLock,
  ) {}

  async list(teamId: string, query: DeparturesQuery): Promise<Page<DepartureDto>> {
    const filters = { teamId };
    const limit = clampLimit(query.limit);
    const after =
      query.cursor === undefined ? undefined : keysetOf(decodeCursor(query.cursor, filters));
    const rows = await this.departures.list(teamId, after, limit + 1);
    const page = buildPage(rows, limit, (row) => [row.dueAt.toISOString(), row.id], filters);
    return { items: await this.dtos(page.items), nextCursor: page.nextCursor };
  }

  async decide(
    userId: string,
    teamId: string,
    departureId: string,
    body: Body<'decideDeparture'>,
  ): Promise<DepartureDto> {
    await this.tx.run(() => this.decideInTx(userId, teamId, departureId, body));
    const row = await this.departures.find(departureId);
    if (row === undefined) throw new DomainError('NOT_FOUND', 404);
    const [dto] = await this.dtos([row]);
    if (dto === undefined) throw new DomainError('NOT_FOUND', 404);
    return dto;
  }

  private async decideInTx(
    userId: string,
    teamId: string,
    departureId: string,
    body: Body<'decideDeparture'>,
  ): Promise<void> {
    const raw = await this.lockDeparture(teamId, departureId);
    if (raw.decision !== 'pending') throw new DomainError('INVALID_STATE', 409);
    const pointer = decisionPointerError(body, raw.seat_ids);
    if (pointer !== undefined) {
      throw new DomainError('VALIDATION_FAILED', 400, {
        errors: [{ pointer, code: 'invalid_value', message: 'Seats of this departure only' }],
      });
    }
    await this.leadLock.lock(teamId, userId);
    const now = this.clock.now();
    if (body.decision === 'continue') await this.closeSeats(teamId, userId, body.closeSeatIds, now);
    await this.departures.decide(departureId, body.decision, userId, now);
    await this.journal(teamId, userId, departureId, body.decision, now);
  }

  /** `departure-default` (C-14): "replace", unless the lead was first. Safe to run twice. */
  async applyDefault(departureId: string): Promise<boolean> {
    return this.tx.run(async () => {
      const known = await this.departures.find(departureId);
      if (known === undefined) return false;
      const raw = await this.lockDeparture(known.teamId, departureId);
      const now = this.clock.now();
      if (raw.decision !== 'pending' || !departureOverdue(new Date(raw.due_at), now)) return false;
      await this.departures.decide(departureId, 'replace', null, now);
      await this.journal(known.teamId, null, departureId, 'replace', now);
      return true;
    });
  }

  /** Lock #3. A departure of another team is "not found". */
  private async lockDeparture(teamId: string, departureId: string): Promise<RawDeparture> {
    const raw = await this.locks.lockTicket<RawDeparture & Record<string, unknown>>(
      'departure',
      departureId,
    );
    if (raw === undefined || raw.team_id !== teamId) throw new DomainError('NOT_FOUND', 404);
    return raw;
  }

  /** The seats the lead gives up; each must still be open (#5, ascending ids). */
  private async closeSeats(
    teamId: string,
    userId: string,
    seatIds: string[] | undefined,
    now: Date,
  ): Promise<void> {
    const ids = [...new Set(seatIds ?? [])].sort();
    if (ids.length === 0) return;
    const locked = await this.locks.lockSeats<RawSeat & Record<string, unknown>>(ids);
    if (locked.length !== ids.length || locked.some((s) => s.team_id !== teamId)) {
      throw new DomainError('NOT_FOUND', 404);
    }
    if (locked.some((s) => s.status !== 'open')) throw new DomainError('INVALID_STATE', 409);
    for (const seat of locked) {
      await this.seats.update(seat.id, { status: 'closed', version: seat.version + 1 });
    }
    await this.teams.adjustSeatCount(teamId, -locked.length, now);
    await this.events.insertMany(
      locked.map((s) =>
        journalRow(teamId, 'seat_closed', userId, { seatId: s.id, roleCode: s.role_code }, now),
      ),
    );
    await this.outbox.publishMany(
      locked.map((s) =>
        teamsEvent('seat_closed', s.id, { seatId: s.id, teamId, roleCode: s.role_code }),
      ),
    );
  }

  /** `userId` is null when the timer decided. */
  private async journal(
    teamId: string,
    userId: string | null,
    departureId: string,
    decision: string,
    now: Date,
  ): Promise<void> {
    const row = journalRow(
      teamId,
      'departure_decided',
      userId ?? '',
      { departureId, decision },
      now,
    );
    await this.events.insertMany([{ ...row, actorUserId: userId }]);
  }

  private async dtos(rows: DepartureRow[]): Promise<DepartureDto[]> {
    const roles = await this.departures.rolesOfSeats(rows.flatMap((row) => row.seatIds));
    return rows.map((row) => toDepartureDto(row, roles));
  }
}
