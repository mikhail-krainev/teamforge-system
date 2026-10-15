import { Body, Controller, Delete, HttpCode, Inject, Param, Patch, Post } from '@nestjs/common';
import { ClsService } from 'nestjs-cls';
import type { Body as BodyOf, Ok } from 'shared';
import { requireUserId } from '../../../../platform/context/cls-store.js';
import { Authz } from '../../../../platform/http/operation.decorator.js';
import { SeatService } from '../services/seat.service.js';

/** addSeats, updateSeat, closeSeat (FR-TEAM-02, FR-TEAM-03, FR-TEAM-12). */
@Controller('v1/teams/:teamId/seats')
export class SeatController {
  constructor(
    @Inject(SeatService) private readonly seats: SeatService,
    @Inject(ClsService) private readonly cls: ClsService,
  ) {}

  @Post()
  @Authz('addSeats')
  addSeats(
    @Param('teamId') teamId: string,
    @Body() body: BodyOf<'addSeats'>,
  ): Promise<Ok<'addSeats'>> {
    return this.seats.add(requireUserId(this.cls), teamId, body);
  }

  @Patch(':seatId')
  @Authz('updateSeat')
  updateSeat(
    @Param('teamId') teamId: string,
    @Param('seatId') seatId: string,
    @Body() body: BodyOf<'updateSeat'>,
  ): Promise<Ok<'updateSeat'>> {
    return this.seats.update(requireUserId(this.cls), teamId, seatId, body);
  }

  @Delete(':seatId')
  @HttpCode(204)
  @Authz('closeSeat')
  async closeSeat(@Param('teamId') teamId: string, @Param('seatId') seatId: string): Promise<void> {
    await this.seats.close(requireUserId(this.cls), teamId, seatId);
  }
}
