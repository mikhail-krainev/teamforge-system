import { Inject, Injectable } from '@nestjs/common';
import { PinoLogger } from 'nestjs-pino';
import { Clock } from '../../../../platform/clock/clock.js';
import { TxRunner } from '../../../../platform/tx/tx-runner.js';
import { WORKSPACE_API, type WorkspaceApi } from '../../../workspace/public.js';
import { SCAN_AGE_MS, SCAN_WINDOW_MS } from '../domain/constants.js';
import { CreditRunRepository } from '../repositories/credit-run.repository.js';
import { CreditRunService } from './credit-run.service.js';

const PAGE = 200;

/**
 * `credit-run-scan` (every 10 minutes, architecture 10.1): the net for a lost or dead
 * `workspace.project_completed`. Completions older than 10 minutes that have no `credit_run` go through the same
 * `CreditRunService.open` as the event; `ON CONFLICT DO NOTHING` makes the scanner and the event safe together.
 */
@Injectable()
export class CreditRunScan {
  constructor(
    @Inject(TxRunner) private readonly tx: TxRunner,
    @Inject(Clock) private readonly clock: Clock,
    @Inject(PinoLogger) private readonly logger: PinoLogger,
    @Inject(WORKSPACE_API) private readonly workspace: WorkspaceApi,
    @Inject(CreditRunRepository) private readonly runs: CreditRunRepository,
    @Inject(CreditRunService) private readonly runService: CreditRunService,
  ) {}

  /** Returns the number of runs opened by this scan (the metric `credit_run_missing_total`). */
  async scan(): Promise<number> {
    const now = this.clock.now();
    const olderThan = now.getTime() - SCAN_AGE_MS;
    const since = new Date(now.getTime() - SCAN_WINDOW_MS);
    let opened = 0;
    let after: { completedAt: Date; teamId: string } | undefined;
    for (;;) {
      const cursor = after;
      const page = await this.workspace.listCompletedTeamsSince(since, {
        limit: PAGE,
        after: cursor,
      });
      const old = page.filter((c) => c.completedAt.getTime() <= olderThan);
      const known = await this.tx.run(() => this.runs.existing(old.map((c) => c.teamId)));
      for (const missing of old.filter((c) => !known.has(c.teamId))) {
        opened += await this.openOne(missing.teamId);
      }
      if (page.length < PAGE || old.length < page.length) return opened;
      after = page.at(-1);
    }
  }

  private async openOne(teamId: string): Promise<number> {
    try {
      return (await this.tx.run(() => this.runService.open(teamId))) ? 1 : 0;
    } catch (error) {
      this.logger.error({ err: error }, `credit-run-scan failed for ${teamId}`);
      return 0;
    }
  }
}
