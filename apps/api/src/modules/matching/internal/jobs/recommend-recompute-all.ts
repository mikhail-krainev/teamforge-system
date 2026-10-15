import { Inject, Injectable, type OnModuleInit } from '@nestjs/common';
import { MaintenanceTasks } from '../../../../platform/queues/maintenance-tasks.js';
import { TEAMS_API, type TeamsApi } from '../../../teams/public.js';
import { RecommendScheduler } from '../services/recommend-scheduler.service.js';

const DAY_MS = 24 * 60 * 60 * 1000;
const SEAT_PAGE = 500;

/** Name of the maintenance task and of its scheduler key. */
export const MATCHING_RECOMPUTE_ALL = 'matching-recompute-all';

/**
 * Full recompute once a day (architecture 6.3): time zones move with daylight saving time, which
 * no event announces. Puts one `recompute-seat` job per open seat on the queue, in the same 5 s
 * windows as the events; the jobs do the work, so the task itself is short and safe to repeat.
 */
@Injectable()
export class RecommendRecomputeAll implements OnModuleInit {
  constructor(
    @Inject(MaintenanceTasks) private readonly maintenance: MaintenanceTasks,
    @Inject(TEAMS_API) private readonly teams: TeamsApi,
    @Inject(RecommendScheduler) private readonly scheduler: RecommendScheduler,
  ) {}

  onModuleInit(): void {
    this.maintenance.register({
      name: MATCHING_RECOMPUTE_ALL,
      everyMs: DAY_MS,
      run: () => this.run(),
    });
  }

  /** Returns the number of seats queued. */
  async run(): Promise<number> {
    let queued = 0;
    let after: string | undefined;
    for (;;) {
      const seats = await this.teams.listOpenSeats({
        limit: SEAT_PAGE,
        ...(after === undefined ? {} : { afterSeatId: after }),
      });
      for (const seat of seats) await this.scheduler.schedule('seat', seat.seatId);
      queued += seats.length;
      if (seats.length < SEAT_PAGE) return queued;
      after = seats.at(-1)?.seatId;
    }
  }
}
