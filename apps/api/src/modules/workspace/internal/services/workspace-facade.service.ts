import { Inject, Injectable } from '@nestjs/common';
import { DomainError } from '../../../../platform/errors/domain-error.js';
import { TxRunner } from '../../../../platform/tx/tx-runner.js';
import type { WorkspaceApi } from '../../public.js';
import type { CompletionSnapshot } from '../domain/completion-snapshot.js';
import { CompletionRepository } from '../repositories/completion.repository.js';

/** What other modules may ask of workspace (`WorkspaceApi`). */
@Injectable()
export class WorkspaceFacade implements WorkspaceApi {
  constructor(
    @Inject(TxRunner) private readonly tx: TxRunner,
    @Inject(CompletionRepository) private readonly completions: CompletionRepository,
  ) {}

  async getCompletion(
    teamId: string,
  ): Promise<{ completedAt: Date; plannedEndAt: Date; overdueDays: number } | null> {
    const row = await this.tx.run(() => this.completions.findCompletion(teamId));
    if (row === undefined) return null;
    return {
      completedAt: row.completedAt,
      plannedEndAt: row.plannedEndAt,
      overdueDays: row.overdueDays,
    };
  }

  async getCompletionSnapshot(teamId: string): Promise<CompletionSnapshot> {
    const row = await this.tx.run(() => this.completions.findCompletion(teamId));
    if (row === undefined) throw new DomainError('NOT_FOUND', 404);
    return row.snapshot as CompletionSnapshot;
  }
}
