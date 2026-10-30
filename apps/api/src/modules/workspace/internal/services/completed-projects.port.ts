import { Inject, Injectable } from '@nestjs/common';
import { inArray } from 'drizzle-orm';
import { TxRunner } from '../../../../platform/tx/tx-runner.js';
import type { CompletedProject, CompletedProjectsPort } from '../../../profiles/public.js';
import { TEAMS_API, type TeamsApi } from '../../../teams/public.js';
import type { CompletionSnapshot } from '../domain/completion-snapshot.js';
import { projectCompletion } from '../schema/completion.js';
import { CompletionRepository } from '../repositories/completion.repository.js';

/**
 * Implements the port of the profiles safety-net scanner `review-eligibility-scan` (profiles may not import
 * workspace): the completions since a moment with the project name and the participants of the record of
 * the completion. Three statements for a page, however many projects it holds.
 */
@Injectable()
export class CompletedProjects implements CompletedProjectsPort {
  constructor(
    @Inject(TxRunner) private readonly tx: TxRunner,
    @Inject(CompletionRepository) private readonly completions: CompletionRepository,
    @Inject(TEAMS_API) private readonly teams: TeamsApi,
  ) {}

  listCompletedSince(
    since: Date,
    page: { limit: number; after?: { completedAt: Date; teamId: string } },
  ): Promise<CompletedProject[]> {
    return this.tx.run(async () => {
      const rows = await this.completions.completedSince(since, page.after, page.limit);
      if (rows.length === 0) return [];
      const ids = rows.map((r) => r.teamId);
      const [names, snapshots] = await Promise.all([
        this.teams.getTeamNames(ids),
        this.tx.tx
          .select({ teamId: projectCompletion.teamId, snapshot: projectCompletion.snapshot })
          .from(projectCompletion)
          .where(inArray(projectCompletion.teamId, ids)),
      ]);
      const members = new Map(
        snapshots.map((s) => [
          s.teamId,
          (s.snapshot as CompletionSnapshot).roster.members.map((m) => m.userId),
        ]),
      );
      return rows.map((row) => ({
        teamId: row.teamId,
        teamName: names.get(row.teamId) ?? '',
        completedAt: row.completedAt,
        memberUserIds: members.get(row.teamId) ?? [],
      }));
    });
  }
}
