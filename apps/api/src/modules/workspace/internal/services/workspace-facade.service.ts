import { Inject, Injectable } from '@nestjs/common';
import { DomainError } from '../../../../platform/errors/domain-error.js';
import { TxRunner } from '../../../../platform/tx/tx-runner.js';
import type { AntifraudFacts, WorkspaceApi } from '../../public.js';
import type { CompletionSnapshot } from '../domain/completion-snapshot.js';
import { AntifraudRepository } from '../repositories/antifraud.repository.js';
import { CompletionRepository } from '../repositories/completion.repository.js';

/** What other modules may ask of workspace (`WorkspaceApi`). */
@Injectable()
export class WorkspaceFacade implements WorkspaceApi {
  constructor(
    @Inject(TxRunner) private readonly tx: TxRunner,
    @Inject(CompletionRepository) private readonly completions: CompletionRepository,
    @Inject(AntifraudRepository) private readonly antifraud: AntifraudRepository,
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

  getAntifraudFacts(teamId: string): Promise<AntifraudFacts> {
    return this.tx.run(async () => {
      const [stages, artifacts, releasePlaceholder] = await Promise.all([
        this.antifraud.stages(teamId),
        this.antifraud.artifacts(teamId),
        this.antifraud.releaseIsPlaceholder(teamId),
      ]);
      const shared = await this.antifraud.sharedHashes(
        teamId,
        artifacts.map((a) => a.sha256),
      );
      return {
        stages,
        artifacts: artifacts.map((a) => ({ ...a, sameHashInOtherTeam: shared.has(a.sha256) })),
        releasePlaceholder,
      };
    });
  }

  findTeamsWithArtifactHashes(hashes: string[], exceptTeamId: string): Promise<string[]> {
    return this.tx.run(() => this.antifraud.teamsWithHashes(hashes, exceptTeamId));
  }

  listCompletedTeamsSince(
    since: Date,
    page: { limit: number; after?: { completedAt: Date; teamId: string } },
  ): Promise<{ teamId: string; completedAt: Date }[]> {
    return this.tx.run(() => this.completions.completedSince(since, page.after, page.limit));
  }
}
