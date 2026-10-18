import { Inject, Injectable } from '@nestjs/common';
import { and, desc, eq, inArray } from 'drizzle-orm';
import { uuidv7 } from 'uuidv7';
import { TxRunner } from '../../../../platform/tx/tx-runner.js';
import { repoLink } from '../schema/repo.js';

export type RepoLinkRow = typeof repoLink.$inferSelect;

export interface NewRepoLink {
  teamId: string;
  repositoryId: number;
  installationId: number;
  fullName: string;
  isPrivate: boolean;
  isFork: boolean;
  repoCreatedAt: Date;
  linkedBy: string;
  linkedAt: Date;
}

/** `github.repo_link`: the repository of a team. Writers hold lock #4 (team) first, then #10 (the row). */
@Injectable()
export class RepoLinkRepository {
  constructor(@Inject(TxRunner) private readonly tx: TxRunner) {}

  /** The link that holds the team's repository now: the active one, or the one of a completed project. */
  async findHolding(teamId: string, lock = false): Promise<RepoLinkRow | undefined> {
    const query = this.tx.tx
      .select()
      .from(repoLink)
      .where(and(eq(repoLink.teamId, teamId), inArray(repoLink.status, ['active', 'completed'])))
      .orderBy(desc(repoLink.linkedAt))
      .limit(1);
    const [row] = await (lock ? query.for('update') : query);
    return row;
  }

  /** CC-9: a `23505` on `repo_link_repository_uq` (another team holds it) surfaces as 409 REPO_TAKEN. */
  async insert(link: NewRepoLink): Promise<RepoLinkRow> {
    const [row] = await this.tx.tx
      .insert(repoLink)
      .values({ id: uuidv7(), status: 'active', ...link })
      .returning();
    if (row === undefined) throw new Error('INSERT repo_link returned no row');
    return row;
  }

  async markUnlinked(id: string, at: Date, reason: string): Promise<void> {
    await this.tx.tx
      .update(repoLink)
      .set({ status: 'unlinked', unlinkedAt: at, unlinkReason: reason })
      .where(and(eq(repoLink.id, id), eq(repoLink.status, 'active')));
  }

  /** T6: the repository of the finished project stays taken for good (AF-01). */
  async markCompleted(teamId: string): Promise<void> {
    await this.tx.tx
      .update(repoLink)
      .set({ status: 'completed' })
      .where(and(eq(repoLink.teamId, teamId), eq(repoLink.status, 'active')));
  }
}
